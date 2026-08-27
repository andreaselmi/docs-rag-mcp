import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, indexPaths, SCHEMA_VERSION } from "../src/store.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "docs-rag-mcp-store-")), "index.db");
}

test("indexPaths: default .db path pairs with index.json alongside", () => {
  assert.deepEqual(indexPaths("/a/b/index.db"), { dbPath: "/a/b/index.db", legacyJson: "/a/b/index.json" });
});

test("indexPaths: a legacy .json indexPath maps to a .db next to it", () => {
  assert.deepEqual(indexPaths("/a/b/index.json"), { dbPath: "/a/b/index.db", legacyJson: "/a/b/index.json" });
});

test("openStore creates a fresh empty schema at the right version", () => {
  const p = tmpDb();
  const store = openStore(p);
  assert.equal(store.count(), 0);
  store.close();
  const raw = new DatabaseSync(p);
  const v = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(v, SCHEMA_VERSION);
  raw.close();
});

test("openStore fails with a clear message on a corrupted db file", () => {
  const p = tmpDb();
  writeFileSync(p, "this is definitely not a sqlite database");
  assert.throws(() => openStore(p), /delete it and run `docs-rag index` to rebuild/);
});

test("openStore wipes the table when user_version does not match", () => {
  const p = tmpDb();
  // Forge a DB that claims a different schema version and holds a row.
  const raw = new DatabaseSync(p);
  raw.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL, mtime INTEGER NOT NULL)");
  raw.exec("INSERT INTO chunks VALUES ('a.md#0', 'a.md', '', 'body', x'00000000', 1)");
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  const store = openStore(p);
  assert.equal(store.count(), 0); // old rows gone, schema recreated
  store.close();
});

function chunk(path: string, i: number, vec: number[], mtime = 1000): import("../src/store.js").StoredChunk {
  return { id: `${path}#${i}`, path, heading: "H", text: `body ${i}`, vector: Float32Array.from(vec), mtime, status: "current", date: null, supersededBy: null };
}

test("replaceFile + loadAll roundtrip preserves vectors bit-exactly", () => {
  const store = openStore(tmpDb());
  store.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [0.25, -1.5, 3.125])]);
  const all = store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "docs/a.md#0");
  assert.equal(all[0].text, "body 0");
  assert.deepEqual(Array.from(all[0].vector), [0.25, -1.5, 3.125]); // exact in float32
  store.close();
});

test("replaceFile really replaces: old rows for the path disappear", () => {
  const store = openStore(tmpDb());
  store.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [1]), chunk("docs/a.md", 1, [2])]);
  store.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [9])]);
  const all = store.loadAll();
  assert.equal(all.length, 1);
  assert.deepEqual(Array.from(all[0].vector), [9]);
  store.close();
});

test("fileMtimes and prunePaths track files by path", () => {
  const store = openStore(tmpDb());
  store.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [1], 111)]);
  store.replaceFile("docs/b.md", [chunk("docs/b.md", 0, [2], 222)]);
  assert.deepEqual(store.fileMtimes(), new Map([["docs/a.md", 111], ["docs/b.md", 222]]));
  store.prunePaths(new Set(["docs/b.md"]));
  assert.deepEqual([...store.fileMtimes().keys()], ["docs/b.md"]);
  store.close();
});

test("transaction rolls back on throw", () => {
  const store = openStore(tmpDb());
  assert.throws(() =>
    store.transaction(() => {
      store.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [1])]);
      throw new Error("boom");
    })
  , /boom/);
  assert.equal(store.count(), 0);
  store.close();
});

test("dataVersion changes when ANOTHER connection commits", () => {
  const p = tmpDb();
  const a = openStore(p);
  const before = a.dataVersion();
  const b = openStore(p);
  b.replaceFile("docs/a.md", [chunk("docs/a.md", 0, [1])]);
  b.close();
  assert.notEqual(a.dataVersion(), before);
  a.close();
});

test("metadata columns roundtrip, nulls included", () => {
  const store = openStore(tmpDb());
  store.replaceFile("docs/old-plan.md", [
    { ...chunk("docs/old-plan.md", 0, [1]), status: "superseded", date: "2026-03-01", supersededBy: "docs/reference/auth.md" },
  ]);
  store.replaceFile("docs/plain.md", [chunk("docs/plain.md", 0, [2])]);
  const byId = new Map(store.loadAll().map((c) => [c.id, c]));
  const old = byId.get("docs/old-plan.md#0")!;
  assert.equal(old.status, "superseded");
  assert.equal(old.date, "2026-03-01");
  assert.equal(old.supersededBy, "docs/reference/auth.md");
  const plain = byId.get("docs/plain.md#0")!;
  assert.equal(plain.status, "current");
  assert.equal(plain.date, null);
  assert.equal(plain.supersededBy, null);
  store.close();
});

test("meta roundtrip: getMeta returns null for an unset key", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const s = openStore(join(dir, "index.db"));
  assert.equal(s.getMeta("embed_model"), null);
  s.setMeta("embed_model", "bge-m3");
  assert.equal(s.getMeta("embed_model"), "bge-m3");
  s.setMeta("embed_model", "nomic-embed-text");
  assert.equal(s.getMeta("embed_model"), "nomic-embed-text");
  s.close();
});

test("onMismatch 'error' refuses to open and leaves the index untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  const w = openStore(dbPath);
  w.setMeta("embed_model", "bge-m3");
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "", text: "hello", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();

  assert.throws(
    () => openStore(dbPath, { expectedModel: "nomic-embed-text", onMismatch: "error" }),
    /built with embed model "bge-m3".*config says "nomic-embed-text"/s
  );

  // L'indice NON deve essere stato toccato dal tentativo fallito.
  const after = openStore(dbPath, { expectedModel: "bge-m3", onMismatch: "error" });
  assert.equal(after.count(), 1);
  after.close();
});

test("onMismatch 'rebuild' drops the chunks and records the new model", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  const w = openStore(dbPath);
  w.setMeta("embed_model", "bge-m3");
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "", text: "hello", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();

  const s = openStore(dbPath, { expectedModel: "nomic-embed-text", onMismatch: "rebuild" });
  assert.equal(s.count(), 0);
  assert.equal(s.getMeta("embed_model"), "nomic-embed-text");
  s.close();
});

test("an index with no recorded model is accepted by any model (unknown provenance)", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  const w = openStore(dbPath);
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "", text: "hello", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();
  const s = openStore(dbPath, { expectedModel: "whatever", onMismatch: "error" });
  assert.equal(s.count(), 1); // nessun errore, nessun drop
  s.close();
});

test("FTS5 mirrors chunks on replaceFile and prunePaths", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const s = openStore(join(dir, "index.db"));
  s.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "Token refresh", text: "ERR_TOKEN_EXPIRED is raised here", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  assert.deepEqual(s.lexicalSearch("ERR_TOKEN_EXPIRED", 5).map((h) => h.id), ["a.md#0"]);

  // Sostituire il file rimuove il testo vecchio dall'indice lessicale.
  s.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "Other", text: "nothing relevant", vector: Float32Array.from([1, 0]), mtime: 2, status: "current", date: null, supersededBy: null },
  ]);
  assert.deepEqual(s.lexicalSearch("ERR_TOKEN_EXPIRED", 5), []);

  // Il pruning di un file lo toglie da entrambe le tabelle.
  s.prunePaths(new Set());
  assert.deepEqual(s.lexicalSearch("nothing", 5), []);
  assert.equal(s.count(), 0);
  s.close();
});

test("headings are lexically searchable, not just body text", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const s = openStore(join(dir, "index.db"));
  s.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "Rotazione delle chiavi", text: "corpo generico", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  assert.deepEqual(s.lexicalSearch("rotazione", 5).map((h) => h.id), ["a.md#0"]);
  s.close();
});

test("a v4 index gains its FTS5 table without losing chunks (in-place migration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  // Simula un indice preesistente privo di tabella FTS.
  const w = openStore(dbPath);
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "H", text: "ERR_TOKEN_EXPIRED here", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP TABLE IF EXISTS chunks_fts");
  raw.exec("PRAGMA user_version = 4");
  raw.close();

  const s = openStore(dbPath);
  assert.equal(s.count(), 1, "the chunks must not be lost: no re-embed");
  assert.deepEqual(s.lexicalSearch("ERR_TOKEN_EXPIRED", 5).map((h) => h.id), ["a.md#0"]);
  s.close();
});

test("a full schema rebuild (out-of-range user_version) also clears chunks_fts, not just chunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  const w = openStore(dbPath);
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "H", text: "ERR_TOKEN_EXPIRED here", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA user_version = 99"); // fuori dall'intervallo migrabile [3, SCHEMA_VERSION]
  raw.close();

  const s = openStore(dbPath);
  assert.equal(s.count(), 0);
  assert.deepEqual(s.lexicalSearch("ERR_TOKEN_EXPIRED", 5), [], "no orphan FTS rows after the schema is recreated");
  s.close();
});

test("onMismatch 'rebuild' clears chunks_fts along with chunks", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const dbPath = join(dir, "index.db");
  const w = openStore(dbPath);
  w.setMeta("embed_model", "bge-m3");
  w.replaceFile("a.md", [
    { id: "a.md#0", path: "a.md", heading: "H", text: "ERR_TOKEN_EXPIRED here", vector: Float32Array.from([1, 0]), mtime: 1, status: "current", date: null, supersededBy: null },
  ]);
  w.close();

  const s = openStore(dbPath, { expectedModel: "nomic-embed-text", onMismatch: "rebuild" });
  assert.equal(s.count(), 0);
  assert.deepEqual(s.lexicalSearch("ERR_TOKEN_EXPIRED", 5), [], "no orphan FTS rows after a model-mismatch rebuild");
  s.close();
});

test("docFreq counts how many chunks contain each term", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
  const s = openStore(join(dir, "index.db"));
  const mk = (id: string, text: string) => ({
    id, path: "a.md", heading: "", text, vector: Float32Array.from([1, 0]),
    mtime: 1, status: "current", date: null, supersededBy: null,
  });
  s.replaceFile("a.md", [
    mk("a.md#0", "authentication happens here"),
    mk("a.md#1", "authentication again"),
    mk("a.md#2", "ERR_TOKEN_EXPIRED only once"),
  ]);
  const df = s.docFreq(["authentication", "err_token_expired", "absent"]);
  assert.equal(df.get("authentication"), 2);
  assert.equal(df.get("err_token_expired"), undefined, "the tokenizer splits on underscores");
  assert.equal(df.get("expired"), undefined, "chiesti solo i termini passati");
  assert.equal(df.get("absent"), undefined);
  s.close();
});
