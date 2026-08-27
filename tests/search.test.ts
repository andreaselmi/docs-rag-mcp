import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/store.js";
import { loadIndex, pathExcluded, applyThresholds, rankWithBoosts, searchRecords, noResultsMessage, metaLabel, viaLabel, LEXICAL_SLOTS } from "../src/search.js";

test("loadIndex fails clearly when the index has not been built", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ vaultPath: "vault" }));
  const cfg = loadConfig(join(dir, "config.json"));
  await assert.rejects(() => loadIndex(cfg), /run `docs-rag index` first/);
});

test("loadIndex hot-reloads when another connection commits (data_version)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ vaultPath: "vault" }));
  const cfg = loadConfig(join(dir, "config.json")); // indexPath -> <dir>/index.db
  const writer = openStore(cfg.indexPath);
  writer.replaceFile("docs/a.md", [
    { id: "docs/a.md#0", path: "docs/a.md", heading: "", text: "first", vector: Float32Array.from([1]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  const before = await loadIndex(cfg);
  assert.deepEqual(before.map((r) => r.text), ["first"]);
  writer.replaceFile("docs/b.md", [
    { id: "docs/b.md#0", path: "docs/b.md", heading: "", text: "second", vector: Float32Array.from([2]), mtime: 2, status: "current", date: null, supersededBy: null },
  ]);
  const after = await loadIndex(cfg);
  assert.deepEqual(after.map((r) => r.text).sort(), ["first", "second"]);
  writer.close();
});

test("pathExcluded: nothing is excluded when no terms are given", () => {
  assert.equal(pathExcluded("docs/archive/old.md", undefined), false);
  assert.equal(pathExcluded("docs/archive/old.md", []), false);
});

test("pathExcluded: excludes a path containing any term (substring match)", () => {
  assert.equal(pathExcluded("docs/archive/old.md", ["archive"]), true);
  assert.equal(pathExcluded("docs/guide.md", ["archive"]), false);
  assert.equal(pathExcluded("packages/api/docs/x.md", ["archive", "packages/api"]), true);
});

test("pathExcluded: match is case-insensitive and ignores blank terms", () => {
  assert.equal(pathExcluded("docs/Archive/x.md", ["archive"]), true);
  assert.equal(pathExcluded("docs/guide.md", ["  "]), false);
});

function hit(path: string, score: number) {
  return { path, heading: "", score, text: "" };
}

test("applyThresholds: empty input stays empty with no rejection", () => {
  assert.deepEqual(applyThresholds([], 0.55, 0.88), { kept: [], bestRejectedScore: null });
});

test("applyThresholds: keeps everything above both thresholds", () => {
  const hits = [hit("a.md", 0.7), hit("b.md", 0.68)];
  assert.deepEqual(applyThresholds(hits, 0.55, 0.88), { kept: hits, bestRejectedScore: null });
});

test("applyThresholds: drops below the absolute floor and reports the best rejected", () => {
  const { kept, bestRejectedScore } = applyThresholds(
    [hit("a.md", 0.7), hit("noise.md", 0.54), hit("junk.md", 0.4)],
    0.55,
    0.88
  );
  assert.deepEqual(kept.map((h) => h.path), ["a.md"]);
  assert.equal(bestRejectedScore, 0.54);
});

test("applyThresholds: drops results far below the top score (relative cut)", () => {
  // top 0.70 → relative floor 0.616: 0.63 stays, 0.60 goes.
  const { kept, bestRejectedScore } = applyThresholds(
    [hit("top.md", 0.7), hit("close.md", 0.63), hit("far.md", 0.6)],
    0.55,
    0.88
  );
  assert.deepEqual(kept.map((h) => h.path), ["top.md", "close.md"]);
  assert.equal(bestRejectedScore, 0.6);
});

test("applyThresholds: a single result above the floor is never self-excluded", () => {
  const only = [hit("a.md", 0.56)];
  assert.deepEqual(applyThresholds(only, 0.55, 0.88).kept, only);
});

test("applyThresholds: everything below the floor -> empty, best rejected reported", () => {
  const { kept, bestRejectedScore } = applyThresholds(
    [hit("a.md", 0.54), hit("b.md", 0.5)],
    0.55,
    0.88
  );
  assert.deepEqual(kept, []);
  assert.equal(bestRejectedScore, 0.54);
});

test("applyThresholds: top survives even when relativeCutoff > 1 (degenerate config)", () => {
  const { kept } = applyThresholds([hit("a.md", 0.7), hit("b.md", 0.6)], 0.55, 1.5);
  assert.deepEqual(kept.map((h) => h.path), ["a.md"]);
});

test("applyThresholds: top survives with negative scores when minScore <= 0 (degenerate config)", () => {
  const { kept } = applyThresholds([hit("a.md", -0.2), hit("b.md", -0.9)], -1, 0.88);
  assert.deepEqual(kept.map((h) => h.path), ["a.md"]);
});

test("rankWithBoosts: an empty map keeps raw-score ordering", () => {
  const ranked = rankWithBoosts([hit("b.md", 0.6), hit("a.md", 0.7)], {});
  assert.deepEqual(ranked.map((h) => h.path), ["a.md", "b.md"]);
});

test("rankWithBoosts: a boosted path overtakes without changing exposed scores", () => {
  const ranked = rankWithBoosts(
    [hit("docs/archive/old.md", 0.66), hit("docs/reference/auth.md", 0.62)],
    { "reference/": 1.15 }
  );
  assert.deepEqual(ranked.map((h) => h.path), ["docs/reference/auth.md", "docs/archive/old.md"]);
  assert.deepEqual(ranked.map((h) => h.score), [0.62, 0.66]); // raw scores untouched
});

test("rankWithBoosts: multiple matching keys multiply (case-insensitive)", () => {
  // 0.5 × 1.2 × 1.2 = 0.72 beats 0.7
  const ranked = rankWithBoosts(
    [hit("docs/Reference/decisions/x.md", 0.5), hit("docs/other/y.md", 0.7)],
    { "reference/": 1.2, "decisions/": 1.2 }
  );
  assert.deepEqual(ranked.map((h) => h.path), ["docs/Reference/decisions/x.md", "docs/other/y.md"]);
});

function rec(path: string, vector: number[]) {
  return { id: path + "#0", path, heading: "", text: "body of " + path, vector };
}

const OPTS = { topK: 8, minScore: 0.55, relativeCutoff: 0.88, pathBoosts: {}, defaultExclude: ["archive", "plans"] };
const QV = [1, 0];

test("searchRecords: default-excluded folders are skipped and flagged when relevant", () => {
  const records = [rec("docs/archive/old.md", [1, 0]), rec("docs/reference/auth.md", [0.9, 0.436])];
  const r = searchRecords(records, QV, OPTS);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/reference/auth.md"]);
  assert.equal(r.defaultExcludedHadCandidates, true);
});

test("searchRecords: searchAll re-includes the default-excluded folders", () => {
  const records = [rec("docs/archive/old.md", [1, 0]), rec("docs/reference/auth.md", [0.9, 0.436])];
  const r = searchRecords(records, QV, OPTS, undefined, true);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/archive/old.md", "docs/reference/auth.md"]);
  assert.equal(r.defaultExcludedHadCandidates, false);
});

test("searchRecords: caller exclude survives searchAll and never triggers the hint", () => {
  const records = [rec("docs/archive/old.md", [1, 0]), rec("docs/reference/auth.md", [0.9, 0.436])];
  const r = searchRecords(records, QV, OPTS, ["archive"], true);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/reference/auth.md"]);
  assert.equal(r.defaultExcludedHadCandidates, false);
});

test("searchRecords: no hint when the excluded folders only held sub-threshold noise", () => {
  const records = [rec("docs/plans/done.md", [0.3, 0.954]), rec("docs/reference/auth.md", [0.9, 0.436])];
  const r = searchRecords(records, QV, OPTS);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/reference/auth.md"]);
  assert.equal(r.defaultExcludedHadCandidates, false);
});

test("searchRecords: out-of-corpus query -> empty hits with best rejected score", () => {
  const records = [rec("docs/reference/auth.md", [0.5, 0.866]), rec("docs/reference/sync.md", [0.4, 0.917])];
  const r = searchRecords(records, QV, OPTS);
  assert.deepEqual(r.hits, []);
  // [0.5, 0.866] is not perfectly normalized -> cosine ≈ 0.50001, so tolerate 1e-3.
  assert.ok(r.bestRejectedScore !== null && Math.abs(r.bestRejectedScore - 0.5) < 1e-3);
  assert.equal(r.defaultExcludedHadCandidates, false);
});

test("searchRecords: boosts reorder the surviving hits", () => {
  const records = [rec("docs/notes/x.md", [0.7, 0.714]), rec("docs/reference/auth.md", [0.65, 0.76])];
  const r = searchRecords(records, QV, { ...OPTS, pathBoosts: { "reference/": 1.15 } });
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/reference/auth.md", "docs/notes/x.md"]);
  assert.deepEqual(r.hits.map((h) => Math.round(h.score * 100) / 100), [0.65, 0.7]);
});

test("searchRecords: respects topK", () => {
  const records = [rec("a.md", [1, 0]), rec("b.md", [0.99, 0.141]), rec("c.md", [0.98, 0.199])];
  const r = searchRecords(records, QV, { ...OPTS, topK: 2 });
  assert.equal(r.hits.length, 2);
});

test("searchRecords fails loudly when a stored vector has a different dimension", () => {
  const records = [
    { id: "a#0", path: "a.md", heading: "", text: "hello", vector: Float32Array.from([1, 0, 0]) },
  ];
  assert.throws(
    () => searchRecords(records, [1, 0], { topK: 5, minScore: 0.1, relativeCutoff: 0.5, pathBoosts: {}, defaultExclude: [] }),
    /dimension mismatch: query has 2, indexed vector has 3/
  );
});

test("noResultsMessage: null when there are hits", () => {
  assert.equal(
    noResultsMessage({ hits: [hit("a.md", 0.7)], bestRejectedScore: null, defaultExcludedHadCandidates: false }, 0.55, ["archive"]),
    null
  );
});

test("noResultsMessage: reports the best rejected score against the threshold", () => {
  assert.equal(
    noResultsMessage({ hits: [], bestRejectedScore: 0.54, defaultExcludedHadCandidates: false }, 0.55, ["archive", "plans"]),
    "No relevant results (best score 0.540, threshold 0.55)."
  );
});

test("noResultsMessage: plain no-results when nothing scored at all", () => {
  assert.equal(
    noResultsMessage({ hits: [], bestRejectedScore: null, defaultExcludedHadCandidates: false }, 0.55, ["archive"]),
    "No results found."
  );
});

test("noResultsMessage: hints at searchAll when skipped folders had candidates", () => {
  assert.equal(
    noResultsMessage({ hits: [], bestRejectedScore: 0.5, defaultExcludedHadCandidates: true }, 0.55, ["archive", "plans"]),
    "No relevant results (best score 0.500, threshold 0.55). " +
      "Note: default-excluded content was skipped (folders: archive, plans; status: superseded/archived) — retry with searchAll: true to include it."
  );
});

test("searchRecords: superseded and archived records are hidden by default and flagged", () => {
  const records = [
    { ...rec("docs/notes/old-plan.md", [1, 0]), status: "superseded", supersededBy: "docs/reference/auth.md" },
    { ...rec("docs/reference/auth.md", [0.9, 0.436]), status: "current" },
  ];
  const r = searchRecords(records, QV, OPTS);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/reference/auth.md"]);
  assert.equal(r.defaultExcludedHadCandidates, true);
});

test("searchRecords: searchAll re-includes hidden statuses, with meta propagated", () => {
  const records = [
    { ...rec("docs/notes/old-plan.md", [1, 0]), status: "archived", date: "2026-01-01" },
    { ...rec("docs/reference/auth.md", [0.9, 0.436]) },
  ];
  const r = searchRecords(records, QV, OPTS, undefined, true);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/notes/old-plan.md", "docs/reference/auth.md"]);
  assert.equal(r.hits[0].status, "archived");
  assert.equal(r.hits[0].date, "2026-01-01");
});

test("searchRecords: draft is label-only, never hidden", () => {
  const records = [{ ...rec("docs/notes/wip.md", [1, 0]), status: "draft" }];
  const r = searchRecords(records, QV, OPTS);
  assert.deepEqual(r.hits.map((h) => h.path), ["docs/notes/wip.md"]);
  assert.equal(r.defaultExcludedHadCandidates, false);
});

test("metaLabel covers all shapes", () => {
  assert.equal(metaLabel({}), "");
  assert.equal(metaLabel({ status: "current" }), "");
  assert.equal(metaLabel({ status: "draft" }), "[draft]");
  assert.equal(metaLabel({ status: "archived" }), "[archived]");
  assert.equal(metaLabel({ status: "superseded" }), "[superseded]");
  assert.equal(
    metaLabel({ status: "superseded", supersededBy: "reference/auth.md", date: "2026-03-01" }),
    "[superseded → reference/auth.md; 2026-03-01]"
  );
  assert.equal(metaLabel({ status: "current", date: "2026-05-19" }), "[2026-05-19]");
});

const lexRec = (id: string, path: string, text: string, vector: number[], status = "current") => ({
  id, path, heading: "", text, vector: Float32Array.from(vector), status, date: null, supersededBy: null,
});
const LEX_OPTS = { topK: 8, minScore: 0.5, relativeCutoff: 0.5, pathBoosts: {}, defaultExclude: ["archive"] };

test("a lexical-only hit survives even when its cosine is below minScore", () => {
  const records = [lexRec("a#0", "a.md", "ERR_TOKEN_EXPIRED", [0, 1])];
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, new Map([["a#0", -0.9]]));
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].via, "lexical");
});

test("a hit found by both tracks is labelled 'both' and keeps its cosine score", () => {
  const records = [lexRec("a#0", "a.md", "match", [1, 0])];
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, new Map([["a#0", -0.9]]));
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].via, "both");
  assert.ok(out.hits[0].score > 0.99);
});

test("superseded docs stay hidden even when the lexical track finds them", () => {
  const records = [lexRec("a#0", "a.md", "ERR_TOKEN_EXPIRED", [0, 1], "superseded")];
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, new Map([["a#0", -0.9]]));
  assert.deepEqual(out.hits, [], "the lifecycle filters both tracks");
});

test("default-excluded folders stay hidden on the lexical track too", () => {
  const records = [lexRec("a#0", "archive/old.md", "ERR_TOKEN_EXPIRED", [0, 1])];
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, new Map([["a#0", -0.9]]));
  assert.deepEqual(out.hits, []);
});

test("caller exclude applies to the lexical track too", () => {
  const records = [lexRec("a#0", "drafts/x.md", "ERR_TOKEN_EXPIRED", [0, 1])];
  const out = searchRecords(records, [1, 0], LEX_OPTS, ["drafts"], false, new Map([["a#0", -0.9]]));
  assert.deepEqual(out.hits, []);
});

test("lexical-only hits are capped at LEXICAL_SLOTS and come after semantic ones", () => {
  const records = [
    lexRec("s#0", "s.md", "semantic", [1, 0]),
    lexRec("l#0", "l1.md", "rare1", [0, 1]),
    lexRec("l#1", "l2.md", "rare2", [0, 1]),
    lexRec("l#2", "l3.md", "rare3", [0, 1]),
  ];
  const lex = new Map([["l#0", -0.9], ["l#1", -0.8], ["l#2", -0.7]]);
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, lex);
  assert.equal(out.hits.length, 1 + LEXICAL_SLOTS);
  assert.equal(out.hits[0].via, "semantic");
  assert.deepEqual(out.hits.slice(1).map((h) => h.path), ["l1.md", "l2.md"], "the best bm25 scores, in order");
});

test("noResultsMessage stays silent when only the lexical track produced hits", () => {
  const records = [lexRec("a#0", "a.md", "ERR_TOKEN_EXPIRED", [0, 1])];
  const out = searchRecords(records, [1, 0], LEX_OPTS, undefined, false, new Map([["a#0", -0.9]]));
  assert.equal(noResultsMessage(out, 0.5, []), null);
});

test("without lexical hits the semantic behaviour is unchanged", () => {
  const records = [lexRec("a#0", "a.md", "unrelated", [0, 1])];
  const out = searchRecords(records, [1, 0], LEX_OPTS);
  assert.deepEqual(out.hits, []);
  assert.match(noResultsMessage(out, 0.5, [])!, /No relevant results \(best score/);
});

test("viaLabel renders the reason a hit was returned", () => {
  assert.equal(viaLabel({ via: "semantic", score: 0.712 }), "[semantic 0.712]");
  assert.equal(viaLabel({ via: "both", score: 0.712 }), "[both 0.712]");
  assert.equal(viaLabel({ via: "lexical", score: 0.104 }), "[exact match]");
});
