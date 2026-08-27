// The retrieval half. Loads the index once, embeds the query, ranks every
// chunk by cosine similarity, returns the top-k. At the typical scale of a
// personal knowledge base (dozens to a few hundred docs) this in-memory
// approach is instant — no vector DB needed.
import { existsSync } from "node:fs";
import { getConfig, type Config } from "./config.js";
import { embed } from "./embed.js";
import { openStore, indexPaths, type Store } from "./store.js";
import { queryTerms, rareTerms, ftsQuery } from "./lexical.js";

export interface IndexRecord {
  id: string;
  path: string;
  heading: string;
  text: string;
  vector: Float32Array | number[];
  status?: string;
  date?: string | null;
  supersededBy?: string | null;
}

let store: Store | null = null;
let cache: IndexRecord[] | null = null;
let cachedVersion = -1;

// Loads the index into memory and keeps it fresh: every call does one cheap
// PRAGMA data_version check — if another connection (a `docs-rag index` run)
// committed since the last load, the cache reloads. No server restarts.
export async function loadIndex(cfg: Config): Promise<IndexRecord[]> {
  const { dbPath } = indexPaths(cfg.indexPath);
  if (!store) {
    if (!existsSync(dbPath)) {
      throw new Error(`Index not found: ${dbPath} — run \`docs-rag index\` first.`);
    }
    store = openStore(dbPath, { expectedModel: cfg.embedModel, onMismatch: "error" });
  }
  try {
    const version = store.dataVersion();
    if (!cache || version !== cachedVersion) {
      cache = store.loadAll();
      cachedVersion = version;
    }
  } catch (e) {
    throw new Error(
      `Index database corrupted: ${dbPath} — delete it and run \`docs-rag index\` to rebuild. (${(e as Error).message})`
    );
  }
  if (cache.length === 0) {
    throw new Error(`Index is empty: ${dbPath} — run \`docs-rag index\` first.`);
  }
  return cache;
}

// The connection loadIndex already holds, reused by the lexical track.
// loadIndex always runs before search, so `store` is set by then; the check
// turns a future ordering mistake into a readable message instead of a crash.
export function activeStore(): Store {
  if (!store) throw new Error("activeStore() called before loadIndex()");
  return store;
}

function cosine(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: query has ${a.length}, indexed vector has ${b.length}. ` +
        "The index was built with a different embedding model — run `docs-rag index` to rebuild it."
    );
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export interface Hit {
  path: string;
  heading: string;
  score: number;
  text: string;
  status?: string;
  date?: string | null;
  supersededBy?: string | null;
  via: "semantic" | "lexical" | "both";
}

// True if `path` should be skipped given the caller's exclude terms.
// Case-insensitive substring match against the record's path; blank terms and
// an absent/empty list mean "exclude nothing" (search everything, the default).
// Pure, so it is unit-tested without Ollama or an index on disk.
export function pathExcluded(path: string, exclude?: string[]): boolean {
  if (!exclude || exclude.length === 0) return false;
  const p = path.toLowerCase();
  return exclude.some((term) => {
    const t = term.trim().toLowerCase();
    return t.length > 0 && p.includes(t);
  });
}

// Two-stage relevance gate on RAW cosine scores (boosts never enter here).
// 1) absolute floor: drop score < minScore (kills out-of-corpus noise).
// 2) relative cut: drop score < relativeCutoff × top surviving score
//    (tightens the tail when the top is strong). The top itself always survives.
// bestRejectedScore lets callers report "best score X below threshold" honestly.
export function applyThresholds(
  hits: Hit[],
  minScore: number,
  relativeCutoff: number
): { kept: Hit[]; bestRejectedScore: number | null } {
  const aboveFloor = hits.filter((h) => h.score >= minScore);
  const top = aboveFloor.reduce((m, h) => Math.max(m, h.score), -Infinity);
  const relativeFloor = Math.min(relativeCutoff * top, top);
  const kept = aboveFloor.filter((h) => h.score >= relativeFloor);
  const rejected = hits.filter((h) => !kept.includes(h));
  const bestRejectedScore = rejected.length
    ? Math.max(...rejected.map((h) => h.score))
    : null;
  return { kept, bestRejectedScore };
}

// Ordering-only boost: multiply the raw score by every matching pathBoosts
// entry (case-insensitive substring, like pathExcluded). Never mutates the
// exposed score — thresholds are already applied, this only sets precedence.
export function rankWithBoosts(hits: Hit[], pathBoosts: Record<string, number>): Hit[] {
  const factor = (path: string): number => {
    const p = path.toLowerCase();
    let f = 1;
    for (const [term, mult] of Object.entries(pathBoosts)) {
      const t = term.trim().toLowerCase();
      if (t.length > 0 && p.includes(t)) f *= mult;
    }
    return f;
  };
  return [...hits].sort((a, b) => b.score * factor(b.path) - a.score * factor(a.path));
}

export interface SearchResult {
  hits: Hit[];
  bestRejectedScore: number | null;
  defaultExcludedHadCandidates: boolean;
}
export interface RankOptions {
  topK: number;
  minScore: number;
  relativeCutoff: number;
  pathBoosts: Record<string, number>;
  defaultExclude: string[];
}

// How many lexical-only results may get in. They are the safety net for rare
// terms, not the main channel: a low cap keeps an exact match on one word from
// taking over the answer.
export const LEXICAL_SLOTS = 2;

// Pure pipeline core (no I/O): testable with hand-made vectors.
// Order is binding: caller exclude → cosine → default-exclude partition →
// absolute floor → relative cut → boosts (ordering only) → topK.
// lexicalIds, when given, maps chunk id -> bm25 score (more negative = more
// relevant). Lifecycle filters (exclude / defaultExclude / status) apply to
// BOTH tracks; minScore/relativeCutoff apply ONLY to the semantic track.
export function searchRecords(
  records: IndexRecord[],
  qv: number[],
  opts: RankOptions,
  exclude?: string[],
  searchAll?: boolean,
  lexicalIds?: Map<string, number>
): SearchResult {
  const scored: (Hit & { id: string })[] = records
    .filter((r) => !pathExcluded(r.path, exclude))
    .map((r) => ({
      id: r.id,
      path: r.path,
      heading: r.heading,
      score: cosine(qv, r.vector),
      text: r.text,
      status: r.status,
      date: r.date,
      supersededBy: r.supersededBy,
      via: "semantic" as const,
    }));
  const isDefaultExcluded = (h: Hit) =>
    searchAll !== true &&
    (pathExcluded(h.path, opts.defaultExclude) || h.status === "superseded" || h.status === "archived");
  // Lifecycle filters apply to BOTH tracks: a superseded doc must not be able
  // to come back in through the lexical door, or the differentiator has a hole.
  const searchable = scored.filter((h) => !isDefaultExcluded(h));
  // The hint fires only when the skipped folders held a chunk that would have
  // cleared the absolute floor — an out-of-corpus query gets no false lead.
  const defaultExcludedHadCandidates = scored.some((h) => isDefaultExcluded(h) && h.score >= opts.minScore);

  // The thresholds apply ONLY to the semantic track: they are cosine
  // quantities, and would mean nothing against bm25 scores.
  const { kept, bestRejectedScore } = applyThresholds(searchable, opts.minScore, opts.relativeCutoff);
  const keptIds = new Set(kept.map((h) => (h as Hit & { id: string }).id));

  for (const h of kept) {
    if (lexicalIds?.has((h as Hit & { id: string }).id)) h.via = "both";
  }
  const semantic = rankWithBoosts(kept, opts.pathBoosts);

  // Solo-lessicali: sopravvissuti ai filtri lifecycle, esclusi dal semantico,
  // ordinati per bm25 crescente (più negativo = più rilevante).
  const lexicalOnly = lexicalIds
    ? searchable
        .filter((h) => lexicalIds.has(h.id) && !keptIds.has(h.id))
        .sort((a, b) => lexicalIds.get(a.id)! - lexicalIds.get(b.id)!)
        .slice(0, LEXICAL_SLOTS)
        .map((h) => ({ ...h, via: "lexical" as const }))
    : [];

  const hits = [...semantic, ...lexicalOnly].slice(0, opts.topK);
  return { hits, bestRejectedScore, defaultExcludedHadCandidates };
}

// One outcome message for both the MCP server and the CLI, so an LLM consumer
// gets evidence ("best score X") instead of silence, and a pointer to
// searchAll only when the skipped folders actually held a candidate.
export function noResultsMessage(
  result: SearchResult,
  minScore: number,
  defaultExclude: string[]
): string | null {
  if (result.hits.length > 0) return null;
  let msg =
    result.bestRejectedScore !== null
      ? `No relevant results (best score ${result.bestRejectedScore.toFixed(3)}, threshold ${minScore}).`
      : "No results found.";
  if (result.defaultExcludedHadCandidates) {
    msg +=
      ` Note: default-excluded content was skipped (folders: ${defaultExclude.join(", ")};` +
      ` status: superseded/archived) — retry with searchAll: true to include it.`;
  }
  return msg;
}

// One bracketed label with everything the consumer should weigh:
// lifecycle status (with the successor doc when known) and the doc date.
// Empty string when there is nothing worth saying (current, no date).
// Why this hit is here. On a lexical-only hit the cosine score is not the
// reason it was included, so it must not be shown as if it were.
export function viaLabel(hit: Pick<Hit, "via" | "score">): string {
  if (hit.via === "lexical") return "[exact match]";
  return `[${hit.via} ${hit.score.toFixed(3)}]`;
}

export function metaLabel(hit: Pick<Hit, "status" | "date" | "supersededBy">): string {
  const parts: string[] = [];
  if (hit.status === "superseded") {
    parts.push(hit.supersededBy ? `superseded → ${hit.supersededBy}` : "superseded");
  } else if (hit.status === "archived" || hit.status === "draft") {
    parts.push(hit.status);
  }
  if (hit.date) parts.push(hit.date);
  return parts.length ? `[${parts.join("; ")}]` : "";
}

export async function search(
  query: string,
  k?: number,
  exclude?: string[],
  searchAll?: boolean
): Promise<SearchResult> {
  const cfg = getConfig();
  const records = await loadIndex(cfg);
  const qv = await embed(query, "query");

  // Lexical track: only the terms the index itself declares rare. Reuses the
  // connection loadIndex already keeps open and fresh — opening and closing a
  // second SQLite handle per query would be pure waste.
  // It is an auxiliary channel: if it fails, search degrades to semantic-only
  // rather than dying. queryTerms/ftsQuery cannot produce malformed MATCH
  // syntax by construction, but an error here must not cross the MCP boundary
  // and kill the whole query over a channel that only recovers rare terms.
  let lexicalIds: Map<string, number> | undefined;
  try {
    const store = activeStore();
    const terms = queryTerms(query);
    const rare = rareTerms(terms, store.docFreq(terms), records.length, cfg.lexicalMaxDocFreq);
    if (rare.length > 0) {
      const rows = store.lexicalSearch(ftsQuery(rare), (k ?? cfg.topK) + LEXICAL_SLOTS);
      lexicalIds = new Map(rows.map((r) => [r.id, r.bm25]));
    }
  } catch (e) {
    // stderr is safe for a stdio MCP server (stdout carries the protocol).
    console.error(`Lexical track unavailable, falling back to semantic-only: ${(e as Error).message}`);
    lexicalIds = undefined;
  }

  return searchRecords(
    records,
    qv,
    {
      topK: k ?? cfg.topK,
      minScore: cfg.minScore,
      relativeCutoff: cfg.relativeCutoff,
      pathBoosts: cfg.pathBoosts,
      defaultExclude: cfg.defaultExclude,
    },
    exclude,
    searchAll,
    lexicalIds
  );
}
