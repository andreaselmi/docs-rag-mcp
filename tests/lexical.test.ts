import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { queryTerms, rareTerms, ftsQuery } from "../src/lexical.js";

test("queryTerms lowercases, splits on non-alphanumerics and drops 1-char noise", () => {
  assert.deepEqual(queryTerms("Why ERR_TOKEN_EXPIRED?"), ["why", "err", "token", "expired"]);
  assert.deepEqual(queryTerms("a b cd"), ["cd"]);
  assert.deepEqual(queryTerms("dup dup"), ["dup"]);
  assert.deepEqual(queryTerms("   "), []);
});

test("rareTerms keeps terms below the frequency ceiling and drops common ones", () => {
  const df = new Map([["authentication", 400], ["err", 2], ["absent", 0]]);
  // soglia = max(5, 0.01 * 1000) = 10
  assert.deepEqual(rareTerms(["authentication", "err", "absent"], df, 1000, 0.01), ["err"]);
});

test("rareTerms applies the absolute floor of 5 on small corpora", () => {
  const df = new Map([["token", 4], ["common", 6]]);
  // soglia = max(5, 0.01 * 50) = 5 -> 'token' (4) passa, 'common' (6) no
  assert.deepEqual(rareTerms(["token", "common"], df, 50, 0.01), ["token"]);
});

test("rareTerms drops terms absent from the index entirely", () => {
  assert.deepEqual(rareTerms(["ghost"], new Map(), 1000, 0.01), []);
});

test("ftsQuery quotes each term and ORs them", () => {
  assert.equal(ftsQuery(["err", "expired"]), '"err" OR "expired"');
  assert.equal(ftsQuery([]), "");
});

// The output of ftsQuery is passed straight to SQLite's FTS5 MATCH, which
// throws on malformed query syntax (empirically: `foo AND (` -> "fts5:
// syntax error", an unterminated quote -> "unterminated string"). The safety
// argument is that queryTerms splits on every non-alphanumeric character, so
// only letters/digits reach ftsQuery, which then wraps each term in double
// quotes. Prove that end-to-end against a real FTS5 MATCH instead of trusting
// the argument as a comment.
test("hostile raw queries survive queryTerms -> ftsQuery -> real FTS5 MATCH", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
  db.exec("INSERT INTO docs(body) VALUES ('foo bar baz vector store c wild near or col value')");
  const stmt = db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?");

  const hostileInputs = [
    "foo AND (",
    '"unterminated',
    "NEAR/2 x",
    "a OR b",
    "col:value",
    "wild*",
    "C++",
    "vector-store",
    "foo^2",
  ];

  for (const input of hostileInputs) {
    const terms = queryTerms(input);
    const query = ftsQuery(terms);
    // "C++" reduces to the single-char term "c", which queryTerms discards
    // as noise (same rule proven above) — a legitimately empty result, not a
    // gap in the hostile-input coverage. When ftsQuery is non-empty, run it
    // against a real MATCH.
    if (query === "") continue;
    assert.doesNotThrow(() => stmt.all(query), `MATCH threw for input: ${input} -> query: ${query}`);
  }

  // No usable terms at all: ftsQuery must return "" and the caller must not
  // attempt the MATCH at all.
  const noTerms = queryTerms("!!! ???");
  assert.equal(ftsQuery(noTerms), "");

  db.close();
});

// The MIN_DOC_FREQ_CEILING floor exists so a small corpus still gets a lexical
// track. Left alone it backfires: on a 2-chunk index the floor of 5 exceeds the
// whole corpus, so a word in EVERY chunk counts as rare, and a nonsense query
// comes back with a confident [exact match]. That is the one thing the tool
// promises not to do.
test("rareTerms: a term present in most of the corpus is never rare, floor or no floor", () => {
  const df = new Map([["how", 2], ["zqftoken", 1]]);
  assert.deepEqual(rareTerms(["how", "zqftoken"], df, 2, 0.01), ["zqftoken"]);
});

test("rareTerms: the majority guard scales — 3 of 4 chunks is still not rare", () => {
  const df = new Map([["client", 3], ["err", 2]]);
  assert.deepEqual(rareTerms(["client", "err"], df, 4, 0.01), ["err"]);
});

test("rareTerms: on a large corpus the majority guard never binds", () => {
  const df = new Map([["errcode", 7]]);
  assert.deepEqual(rareTerms(["errcode"], df, 4000, 0.01), ["errcode"], "7 <= max(5, 40) e 7 è ben sotto la metà");
});
