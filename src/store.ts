// SQLite-backed chunk store. ALL SQL lives here; the indexer and the search
// layer consume this small synchronous API (node:sqlite is synchronous).
// Requires Node >= 22.5 (node:sqlite is stdlib; experimental warning on
// stderr before 23.4 — harmless, and stderr is safe for a stdio MCP server).
import { DatabaseSync } from "node:sqlite";

// Version of the schema AND of the chunking scheme. Bump it whenever either
// changes shape: any DB with a different (or missing) version is dropped and
// recreated empty, forcing the next `docs-rag index` to rebuild everything —
// otherwise mtime-based reuse would freeze chunks in the old format forever.
// v2: chunker v2 (min-body filter, code-fence collapse, oversize split).
// v3: frontmatter metadata columns (status, date, superseded_by).
// v4: meta table (embedding model identity and vector dimension).
//     Additive migration from v3: no re-embed, the chunks stay.
// v5: FTS5 table for the lexical track (additive migration from v4).
export const SCHEMA_VERSION = 5;

export interface StoredChunk {
  id: string; // "<path>#<i>"
  path: string; // vault-relative
  heading: string;
  text: string;
  vector: Float32Array;
  mtime: number;
  status: string; // "current" | "draft" | "superseded" | "archived"
  date: string | null;
  supersededBy: string | null;
}

export interface Store {
  fileMtimes(): Map<string, number>;
  replaceFile(path: string, chunks: StoredChunk[]): void;
  prunePaths(keep: Set<string>): void;
  loadAll(): StoredChunk[];
  count(): number;
  dataVersion(): number;
  transaction<T>(fn: () => T): T;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  lexicalSearch(query: string, limit: number): { id: string; bm25: number }[];
  docFreq(terms: string[]): Map<string, number>;
  close(): void;
}

// Where the DB lives and where a pre-SQLite index.json would be, for any
// configured indexPath. A legacy ".json" indexPath keeps pointing at the JSON
// (conversion source) and puts the DB next to it.
export function indexPaths(indexPath: string): { dbPath: string; legacyJson: string } {
  if (indexPath.endsWith(".json")) {
    return { dbPath: indexPath.slice(0, -".json".length) + ".db", legacyJson: indexPath };
  }
  const base = indexPath.endsWith(".db") ? indexPath.slice(0, -".db".length) : indexPath;
  return { dbPath: indexPath, legacyJson: base + ".json" };
}

export function openStore(
  dbPath: string,
  opts: { expectedModel?: string; onMismatch?: "rebuild" | "error" } = {}
): Store {
  const onMismatch = opts.onMismatch ?? "error";
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Rows are managed explicitly by replaceFile / prunePaths, like every other
    // piece of SQL in this file. `path` is UNINDEXED and exists only so a file
    // can be deleted without a subquery. remove_diacritics 2 is for accented
    // languages ("perché" is found when searching "perche" too).
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(" +
        "id UNINDEXED, path UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')"
    );
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab USING fts5vocab(chunks_fts, 'row')");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const hasChunks =
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get() !== undefined;

    // From v3 on, the `chunks` schema has not changed: every version in the
    // range [3, SCHEMA_VERSION] can be migrated additively (new tables are
    // created alongside). Outside that range — 0, or an unknown, corrupt or
    // newer version — there is no guarantee about which columns exist, so it is
    // recreated from scratch.
    if (!hasChunks || version < 3 || version > SCHEMA_VERSION) {
      // No reusable schema: start over (the next index run fills it).
      db.exec("DROP TABLE IF EXISTS chunks");
      db.exec(
        "CREATE TABLE chunks (" +
          "id TEXT PRIMARY KEY, path TEXT NOT NULL, heading TEXT NOT NULL, " +
          "text TEXT NOT NULL, vector BLOB NOT NULL, mtime INTEGER NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'current', date TEXT, superseded_by TEXT)"
      );
      db.exec("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)");
      // chunks_fts was already created above (CREATE VIRTUAL TABLE IF NOT
      // EXISTS): empty it here rather than redefining it, or orphan rows from
      // vanished files would stay forever (prunePaths only walks `chunks`).
      db.exec("DELETE FROM chunks_fts");
    }
    // v3 -> v4 is additive: the meta table already exists (created above) and
    // the chunks stay valid. embed_model is deliberately NOT written here: the
    // model a v3 index was built with cannot be known, and assuming one would
    // bless a possibly wrong pairing. The next `index` run writes it.
    const chunksCount = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
    if (chunksCount > 0 && ftsCount === 0) {
      db.exec("INSERT INTO chunks_fts (id, path, body) SELECT id, path, heading || ' ' || text FROM chunks");
    }
    if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch (e) {
    throw new Error(
      `Index database corrupted: ${dbPath} — delete it and run \`docs-rag index\` to rebuild. (${(e as Error).message})`
    );
  }

  const readMeta = (key: string): string | null => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  };
  const writeMeta = (key: string, value: string): void => {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  };

  // Model identity. An index with no recorded model (a migrated v3) is accepted
  // by anyone: unknown provenance, not a contradiction.
  const recorded = readMeta("embed_model");
  if (opts.expectedModel && recorded && recorded !== opts.expectedModel) {
    if (onMismatch === "error") {
      db.close();
      throw new Error(
        `Index at ${dbPath} was built with embed model "${recorded}", but the config says "${opts.expectedModel}". ` +
          "Vectors from different models are not comparable. Run `docs-rag index` to rebuild the index with the configured model."
      );
    }
    db.exec("DELETE FROM chunks");
    db.exec("DELETE FROM chunks_fts");
    writeMeta("embed_model", opts.expectedModel);
  } else if (opts.expectedModel && !recorded && onMismatch === "rebuild") {
    writeMeta("embed_model", opts.expectedModel);
  }

  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, path, heading, text, vector, mtime, status, date, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const deleteByPath = db.prepare("DELETE FROM chunks WHERE path = ?");
  const insertFts = db.prepare("INSERT INTO chunks_fts (id, path, body) VALUES (?, ?, ?)");
  const deleteFtsByPath = db.prepare("DELETE FROM chunks_fts WHERE path = ?");

  return {
    fileMtimes() {
      const rows = db.prepare("SELECT DISTINCT path, mtime FROM chunks").all() as { path: string; mtime: number }[];
      return new Map(rows.map((r) => [r.path, r.mtime]));
    },
    // No BEGIN here: atomicity belongs to the caller's transaction() so that
    // multi-file runs commit as one unit (SQLite has no nested transactions).
    replaceFile(path: string, chunks: StoredChunk[]) {
      deleteFtsByPath.run(path);
      deleteByPath.run(path);
      for (const c of chunks) {
        const bytes = new Uint8Array(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength);
        insertChunk.run(c.id, c.path, c.heading, c.text, bytes, c.mtime, c.status, c.date, c.supersededBy);
        insertFts.run(c.id, c.path, `${c.heading} ${c.text}`);
      }
    },
    prunePaths(keep: Set<string>) {
      const rows = db.prepare("SELECT DISTINCT path FROM chunks").all() as { path: string }[];
      for (const r of rows) {
        if (!keep.has(r.path)) {
          deleteFtsByPath.run(r.path);
          deleteByPath.run(r.path);
        }
      }
    },
    loadAll() {
      const rows = db
        .prepare("SELECT id, path, heading, text, vector, mtime, status, date, superseded_by FROM chunks")
        .all() as { id: string; path: string; heading: string; text: string; vector: Uint8Array; mtime: number; status: string; date: string | null; superseded_by: string | null }[];
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        heading: r.heading,
        text: r.text,
        vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4),
        mtime: r.mtime,
        status: r.status,
        date: r.date,
        supersededBy: r.superseded_by,
      }));
    },
    count() {
      return (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    },
    // Bumped by commits from OTHER connections — the freshness signal the
    // search layer polls per query. A connection's own writes don't change it.
    dataVersion() {
      return (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getMeta: readMeta,
    setMeta: writeMeta,
    lexicalSearch(query: string, limit: number) {
      // The query arrives as an FTS5 string: the terms come already sanitised
      // from the caller (see ftsQuery in lexical.ts).
      if (query.trim().length === 0) return [];
      const rows = db
        .prepare("SELECT id, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?")
        .all(query, limit) as { id: string; s: number }[];
      return rows.map((r) => ({ id: r.id, bm25: r.s }));
    },
    // fts5vocab exposes, for every indexed term, `doc` = how many documents it
    // appears in. That is exactly what the rarity gate needs.
    docFreq(terms: string[]) {
      const out = new Map<string, number>();
      if (terms.length === 0) return out;
      const stmt = db.prepare("SELECT doc FROM chunks_vocab WHERE term = ?");
      for (const t of terms) {
        const row = stmt.get(t.toLowerCase()) as { doc: number } | undefined;
        if (row && row.doc > 0) out.set(t.toLowerCase(), row.doc);
      }
      return out;
    },
    close() {
      db.close();
    },
  };
}
