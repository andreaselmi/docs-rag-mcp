// Build the search index: walk docs/, chunk, embed, upsert into SQLite.
//   docs-rag index  (or `yarn index` from source)
// Incremental: unchanged files (same mtime) are neither read nor rewritten.
// All writes land in ONE final transaction: a crash mid-run changes nothing.
// First run over a pre-SQLite project finds a leftover index.json, parks it
// as .bak (the old vectors can't be reused), and runs a full re-embed.
import { globby } from "globby";
import { existsSync, renameSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfig } from "./config.js";
import { chunkMarkdown } from "./chunk.js";
import { embedBatch } from "./embed.js";
import { openStore, indexPaths, type StoredChunk } from "./store.js";
import { parseFrontmatter, type DocMeta } from "./frontmatter.js";
import { calibrateMinScore } from "./calibrate.js";
import { modelSpec } from "./models.js";

const BATCH = 16; // chunks per Ollama request
const CONCURRENCY = 4; // simultaneous requests

interface Pending {
  rel: string;
  i: number;
  heading: string;
  text: string;
  ctx: string;
  mtime: number;
  meta: DocMeta;
}

export async function main() {
  const { vaultPath, includeGlobs, excludeGlobs, indexPath, embedModel, minScore, explicitKeys } = getConfig();
  const { dbPath, legacyJson } = indexPaths(indexPath);
  // The indexer is the only path authorized to rebuild: a model change here
  // is an instruction, not an error.
  const store = openStore(dbPath, { expectedModel: embedModel, onMismatch: "rebuild" });

  // A pre-SQLite index.json can't be reused: the chunking scheme has changed
  // since (schema v2), so its vectors describe chunks that no longer exist.
  // Park it as .bak and let the full re-embed below rebuild everything.
  if (store.count() === 0 && existsSync(legacyJson)) {
    renameSync(legacyJson, legacyJson + ".bak");
    console.error(`Found legacy ${legacyJson}: chunking has changed, running a full re-embed (old file kept as .bak).`);
  }

  const files = await globby(includeGlobs, { cwd: vaultPath, ignore: excludeGlobs, absolute: true });
  const known = store.fileMtimes();

  const pending: Pending[] = [];
  const currentRels = new Set<string>();
  const fresh = new Map<string, StoredChunk[]>();
  let unchanged = 0;

  for (const file of files) {
    const rel = relative(vaultPath, file);
    currentRels.add(rel);
    const mtime = Math.floor((await stat(file)).mtimeMs);
    if (known.get(rel) === mtime) {
      unchanged++; // untouched: stays in the DB as-is
      continue;
    }
    // Seed now so a changed file that yields zero chunks (e.g. everything
    // dropped by the min-body filter) still gets its stale rows replaced
    // (deleted) below, instead of surviving forever. It has no stored mtime
    // afterward, so it re-parses each run (cheap: nothing to embed).
    fresh.set(rel, []);
    const { meta, body, warning } = parseFrontmatter(await readFile(file, "utf8"));
    if (warning) console.error(`${rel}: ${warning}`);
    const chunks = chunkMarkdown(body);
    chunks.forEach((c, i) => {
      const ctx = `${rel}${c.heading ? " > " + c.heading : ""}\n\n${c.embedText}`;
      pending.push({ rel, i, heading: c.heading, text: c.text, ctx, mtime, meta });
    });
  }

  console.error(
    `${files.length} files | ${unchanged} unchanged | embedding ${pending.length} chunks from ${files.length - unchanged} new/changed files`
  );

  const batches: Pending[][] = [];
  for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const vectors = await embedBatch(batch.map((p) => p.ctx), "document");
      batch.forEach((p, j) => {
        fresh.get(p.rel)!.push({
          id: `${p.rel}#${p.i}`,
          path: p.rel,
          heading: p.heading,
          text: p.text,
          vector: Float32Array.from(vectors[j]),
          mtime: p.mtime,
          status: p.meta.status,
          date: p.meta.date,
          supersededBy: p.meta.supersededBy,
        });
      });
      done += batch.length;
      console.error(`  embedded ${done}/${pending.length}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  // One atomic swap: changed files replaced, deleted files pruned.
  store.transaction(() => {
    for (const [rel, chunks] of fresh) store.replaceFile(rel, chunks);
    store.prunePaths(currentRels);
  });

  store.setMeta("embed_model", embedModel);
  const all = store.loadAll();
  if (all.length > 0) store.setMeta("vector_dim", String(all[0].vector.length));

  // The threshold must be measured, not inherited: see src/calibrate.ts.
  const cal = calibrateMinScore(all.map((c) => c.vector));
  if (cal) {
    store.setMeta("suggested_min_score", String(cal.suggested));
    const explicit = explicitKeys.includes("minScore");
    const known = modelSpec(embedModel).minScore !== undefined;
    console.error(
      `Calibration: background noise p99 = ${cal.noiseP99.toFixed(3)} over ${cal.pairs} random pairs ` +
        `-> suggested minScore ${cal.suggested} (in use: ${minScore}${explicit ? ", set in config" : known ? ", from the model registry" : ", default"}).`
    );
    if (!explicit && !known && Math.abs(cal.suggested - minScore) >= 0.05) {
      console.error(
        `  Hint: "${embedModel}" is not in the model registry and the configured minScore is far from the measured noise floor. ` +
          `Consider setting "minScore": ${cal.suggested} in your config.`
      );
    }
  }

  // The registry match is exact (tag stripped). A model whose name merely
  // resembles a known one (e.g. "nomic-embed-text-v2") falls through to the
  // empty fallback spec silently: no prefix is applied, and nothing else in
  // the output would hint at it. Surface that here, next to the calibration
  // report, since both are diagnostics about how well this model is understood.
  const spec = modelSpec(embedModel);
  const isUnknownModel = spec.dim === undefined && spec.queryPrefix === "" && spec.documentPrefix === "";
  if (isUnknownModel) {
    console.error(
      `No prefix convention is known for model "${embedModel}". Some embedding models require a task ` +
        `prefix on queries and documents; retrieval quality may be reduced without it.`
    );
  }

  console.error(`Done. ${store.count()} chunks in index (${pending.length} re-embedded) -> ${dbPath}`);
  store.close();
}

// Only run when executed directly (not when imported by the CLI or by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
