# docs-rag-mcp

**It isn't a better search engine over your docs. It's a filter on what the
agent is allowed to believe:** superseded decisions disappear, the threshold
says *"I don't know"* instead of inventing, and you always see why a result
got in.

An MCP server that exposes a folder of markdown documents to any MCP client
(Claude Code, Claude Desktop, Codex, Cursor, Zed…) as one search tool,
`search_notes`. Everything runs on your machine: embeddings go through
[Ollama](https://ollama.com), and nothing leaves your computer at index time
or at query time.

```
npx -y docs-rag-mcp init      # guided questions -> config.json
npx -y docs-rag-mcp index     # builds the index
```

> **Writing the docs you'll search?** How you structure a markdown file decides
> how well it can be found. See **[AUTHORING.md](AUTHORING.md)** — a short guide
> to writing docs that retrieve well. Five minutes there improves every search.

## What actually makes this different

Most of what this tool does, other local RAG servers also do. The part that is
genuinely rare is the **document lifecycle**: the index knows that a document
has been superseded, and acts on it.

- A doc marked `status: superseded` in its frontmatter **stops being returned**
  by default. When it does come back — because you asked for history
  explicitly — it arrives labelled `[superseded → reference/auth.md; 2026-03-01]`,
  so the successor travels with it.
- Below `minScore`, the tool says **"No relevant results (best score 0.41,
  threshold 0.55)"** instead of handing over the closest noise it found. An
  agent given a bad match treats it as ground truth; a human would have
  hesitated. The threshold is where that hesitation lives.
- Every hit shows **why it is there**: `[semantic 0.712]`, `[both 0.712]`,
  `[exact match]`. Not a black box you have to trust.

Everyone else does file freshness — re-sync, re-index, watch for changes.
Nobody does **truth freshness**. That is the whole point of this tool.

| | approach | handles document lifecycle? |
|---|---|---|
| **docs-rag-mcp** | dense + lexical, SQLite, Ollama | **yes** — `status`/`superseded_by`, default-excluded archives, honest no-results |
| `zilliztech/claude-context` | hybrid BM25+dense, AST chunking, Milvus | no |
| `shinpr/mcp-local-rag` | semantic+keyword, LanceDB, PDF/DOCX/MD | no |
| `Zackriya/MCP-Markdown-RAG` | markdown, heading chunking, Milvus | no |
| `proofgeist/obsidian-notes-rag` | sqlite-vec + Ollama, graph-aware | no |
| `patakuti/local-knowledge-rag-mcp` | pgvector | no |

The rest — local-only, chunking by heading, SQLite storage, incremental
indexing — is table stakes in this field, not a differentiator. It's in the
feature table below, not in the pitch.

## When you don't need this

Honest version, because the field moved:

- **For exact matches on symbols, your agent already has grep**, and grep is
  faster and needs no index. Function names, error codes, config keys: don't
  build a vector index for that.
- **Below a few dozen documents, agentic search is enough.** The agent reads
  the file tree, greps, opens what looks relevant. That works.
- **Anthropic shipped RAG with a vector DB inside Claude Code and then removed
  it** (May 2025), because agentic search outperformed it. Cursor, Windsurf,
  Cline and others went the same way. Pretending otherwise would be dishonest.

What survives that, and is why this exists: **grep finds what you name.** When
the doc calls it "token refresh window" and you call it "session expiry", grep
returns nothing and semantic search returns the doc. And on a long, layered
corpus, semantic retrieval costs **fewer round-trips and fewer tokens** than
having the agent walk the tree — not "better results", *cheaper* results.

So the fit is narrow and specific: **a long, layered corpus of decisions, specs
and ADRs in markdown, with superseded material in it, where you need the agent
not to resurrect a dead decision.**

## Prerequisites

- **Node.js ≥ 22.5** — the index uses the built-in `node:sqlite` module, so
  there are no native dependencies to build. Depending on your Node version
  you may see a one-line warning on stderr (`ExperimentalWarning: SQLite is
  an experimental feature`); it's harmless.
- **Ollama with an embedding model.** The model is required both to build the
  index *and on every search* — the query is embedded on the fly, so Ollama
  must be running whenever the MCP server is in use, not only at index time.

  ```
  # install Ollama from https://ollama.com, then:
  ollama pull bge-m3
  ```

## Install

The published package needs no clone and no build:

```
npx -y docs-rag-mcp init      # guided questions -> writes config.json
npx -y docs-rag-mcp index     # builds the index
```

**If you plan to use the auto re-index hook, install it globally instead:**

```
npm i -g docs-rag-mcp
```

`npx` re-resolves the package on every spawn and downloads it on first use.
That is irrelevant for the MCP server, which starts once per session, but the
hook is designed to exit in zero seconds and runs after every file edit — a
global install removes that overhead entirely. `docs-rag scaffold` detects a
global install and writes the shorter command form on its own.

Prefer editing a config by hand? Copy `config.example.json` to `config.json`
and set `vaultPath`. Everything else has sensible defaults.

<details>
<summary>Working from source</summary>

```
git clone https://github.com/andreaselmi/docs-rag-mcp
cd docs-rag-mcp
yarn install
yarn setup          # -> config.json
yarn index
yarn build          # compiles to dist/
```

The `yarn` scripts map one-to-one onto the subcommands (`setup`→`init`,
`serve`, `index`, `search`, `scaffold`). When scaffolding a project from a
source checkout, pass **`--local`**: it writes `node /abs/path/dist/server.js`
into the generated files instead of an `npx` command that would resolve to the
published package rather than your working tree.

</details>

## Agent skill

[`skills/docs-rag`](skills/docs-rag/SKILL.md) is a SKILL.md skill that
teaches the agent to use this server well. It covers how to set it up, how
to weigh `[semantic]` / `[both]` / `[exact match]` hits, why
"No relevant results" is an answer rather than a bug, and how to record a
changed decision so the old one stops being returned. Copy the folder into
`~/.claude/skills/` (or your agent's skills directory). `yarn pack-skill`
builds a standalone zip that also includes `AUTHORING.md`.

## The commands

```
docs-rag init                 interactive wizard, writes config.json
docs-rag scaffold <dir>       give a project its own scoped instance
docs-rag index                build or update the index
docs-rag search "question"    query the index from the terminal
docs-rag serve                run the MCP server on stdio
docs-rag hook                 Claude Code hook entry point (auto re-index)
```

Every command accepts `--config <path>`.

## Test retrieval from the terminal

```
docs-rag search "how do we handle authentication"
```

You'll see the matching sections, each with the reason it was returned:

```
[semantic 0.712]  reference/auth.md › Auth > How the client refreshes the token
[both 0.688]      decisions/2026-01-session-length.md › Session length  [2026-01-14]
[exact match]     reference/errors.md › Error codes > ERR_TOKEN_EXPIRED
```

This is exactly the retrieval the MCP client will use — verify it here first.

To skip folders for a single query, pass `--exclude` (comma-separated path
fragments, case-insensitive):

```
docs-rag search "how do we handle auth" --exclude archive,drafts
```

The MCP tool exposes the same thing as an optional `exclude` array on
`search_notes`, so you can ask *"search, but ignore the archive folder"* in
conversation.

Some folders (`archive`, `plans` by default — see `defaultExclude`) are skipped
on every query, not just when you pass `--exclude`. To search them anyway for
one query, pass `--all` (CLI) or `searchAll: true` (the tool parameter). The
same flag re-includes docs marked `superseded`/`archived` in frontmatter, which
are hidden from default search too.

## Two retrieval tracks, and the labels

Dense embeddings are weak on exactly the things a spec is full of: acronyms,
error codes, function names, version numbers. So each query runs two tracks and
merges them.

- The **semantic** track ranks every chunk by cosine similarity and applies the
  thresholds.
- The **lexical** track is a full-text (FTS5) search restricted to the *rare*
  terms of your query. "Rare" is measured against your own index: a term
  qualifies if it appears in at most `max(5, lexicalMaxDocFreq × total chunks)`
  chunks, and in no more than half of them. Running FTS on every word would
  flood the results with matches on common terms; the rarity gate is what keeps
  it precise.

The label on each hit tells you which track put it there:

| label | meaning |
|---|---|
| `[semantic 0.712]` | found by meaning, cosine score `0.712` |
| `[both 0.712]` | found by both tracks — the strongest signal |
| `[exact match]` | lexical only. **No score shown on purpose**: the cosine value is not the reason this hit is here, and printing it would suggest otherwise |

Lexical-only hits are capped (2 slots) and always come after the semantic ones,
so a rare-term match can add to the answer but never take it over.

## Embedding models

Any embedding model available on Ollama works — set `embedModel` in the config.
`bge-m3` is the default and the thresholds ship tuned for it.

**Changing `embedModel` now forces a full rebuild.** The index records which
model built it; opening it with a different one is refused rather than silently
scored against incompatible vectors. Earlier versions would have quietly mixed
them and returned wrong results with no error at all.

Some models need a task prefix on the input (`nomic-embed-text` wants
`search_query:` / `search_document:`). Those live in a small registry, applied
for you. If you pick a model the registry doesn't know, `docs-rag index` says
so — the search still works, but nobody has verified the prefix convention or
the thresholds for it.

### The calibration report

At the end of every index run you get a line like:

```
Calibration: background noise p99 = 0.421 over 500 random pairs -> suggested minScore 0.45 (in use: 0.55, from the model registry).
```

It samples random chunk pairs from your own corpus, which are by definition
*unrelated*, and reports the similarity score they reach anyway. That is the
model's noise floor: anything scoring below it is indistinguishable from two
documents that have nothing to do with each other.

Use it as a lower bound, not a setting to copy. If the suggested value is far
*above* your configured `minScore`, your threshold is admitting noise. If it's
far below, you're free to be stricter. A configured value always wins — the
report never overwrites your choice, it only tells you what it measured.

## One instance per project (recommended)

You usually want a separate knowledge base per project. You do **not** need a
copy of this tool per project — install it once, then give each project its own
config, registered at project scope:

```
docs-rag scaffold /path/to/some-project     # asks a few questions (or pass flags)
```

For that project it writes:

- `some-project/.rag/config.json` — its config (`vaultPath` is the project
  root; the index lands in `.rag/index.db`, next to it). **Re-running scaffold
  on an already scaffolded project preserves this file**: tuned `pathBoosts`
  and thresholds survive, and only keys you passed explicitly as flags on that
  run are overwritten.
- `some-project/.mcp.json` — a project-scoped MCP registration. Existing
  servers in it are preserved. Because the command carries no machine-specific
  path, **this file is committable**: whoever clones the repo gets search over
  its docs without installing anything by hand.
- appends `.rag/index.db*` and the legacy `.rag/index.json*` to the project's
  `.gitignore`.
- with `--hook`: `some-project/.claude/settings.local.json`, a Claude Code hook
  that re-indexes in the background after every markdown edit (see below).

Then:

```
docs-rag index --config /path/to/some-project/.rag/config.json
```

Non-interactive, scriptable across many repos:

```
docs-rag scaffold /path/to/proj --name proj-docs --include "**/docs/**/*.md" \
  --desc "What's in this project's docs" --hook --yes
```

### How `--config` is resolved

Every command accepts `--config`. A config file "carries" its own index (a
relative `indexPath` resolves next to the config file), so instances never
interfere. Resolution order:

1. An **absolute** path always wins.
2. `CLAUDE_PROJECT_DIR`, which Claude Code sets to the project root in the
   environment of the servers and hooks it spawns.
3. **Walking up from the working directory** to the first ancestor where the
   path exists. This is what makes `--config .rag/config.json` work on clients
   that set no environment variable of their own.
4. Otherwise the working directory.

With no `--config` at all, the same walk-up looks for `.rag/config.json`, so
running `docs-rag search "…"` anywhere inside a scaffolded project just works.

Do **not** write `${CLAUDE_PROJECT_DIR}` into `.mcp.json` args yourself: Claude
Code does not expand variables there, so it would be passed through literally.

## Wiring it into an MCP client

### Claude Code

Project scope is what `docs-rag scaffold` sets up. For a knowledge base you
want in *every* session instead, register at user scope:

```
claude mcp add work-docs -s user -- npx -y docs-rag-mcp serve --config ~/vaults/work.json
```

Check it's connected with `claude mcp list`, then ask something like
*"search_notes: why did we choose X?"*.

### Codex CLI, Cursor, Zed, and other MCP clients

The server is plain stdio MCP, so any client that speaks the protocol can run
it. In Codex CLI's `~/.codex/config.toml`:

```toml
[mcp_servers.docs-search]
command = "npx"
args = ["-y", "docs-rag-mcp", "serve", "--config", "/absolute/path/to/.rag/config.json"]
```

Cursor and Zed take the same command and args in their own MCP settings.

**An absolute `--config` is the form to use here**, because it depends on
nothing. A relative one also works via the directory walk-up described above —
but that path is verified by construction and unit tests, **not** tested
against those clients. If you run it on one of them, a report is welcome.

Give each instance its own `serverName` and `toolDescription`: the description
is what the model reads to decide whether to call the tool at all, so describe
*what is in this knowledge base*, not what the tool does.

## Keeping the index fresh

The index is a build artifact: `index.db`, a SQLite database in WAL mode, with
its `-wal` and `-shm` sidecars. After editing docs, re-run `docs-rag index` —
it's incremental, only re-embedding files whose mtime changed. A running MCP
server picks up every re-index automatically, no restart needed. *A stale index
answers with stale content — worse than a miss.*

### Automatic re-index (Claude Code only, opt-in)

Scaffold with `--hook` and a Claude Code
[PostToolUse hook](https://code.claude.com/docs/en/hooks) re-runs the
incremental indexer in the background whenever Claude writes or edits a
markdown file in that project — coalesced to at most one run every 30 seconds,
with no edit left behind. Edits made outside Claude Code still need a manual
run.

The hook lives in the project's `.claude/settings.local.json` (personal, not
committed); delete the `PostToolUse` entry to disable it. If a background run
can't work — most often because Ollama isn't running — you get one warning per
episode in the session, not one per save, and the details land in
`.rag/hook.log`. Other MCP clients don't run Claude Code hooks: there, re-index
by hand.

### Upgrading an existing index

The first `docs-rag index` after upgrading is a **one-time full re-embed**, not
the usual sub-second no-op: the schema gained the model-identity table and the
FTS5 table, and old vectors can't be carried across. With the hook enabled it
starts in the background on your first edit, so expect that first run to take
minutes rather than a second.

Upgrading from the original `index.json`: it's renamed to `index.json.bak` and
rebuilt from scratch. Delete the `.bak` once you're happy with the result.

## Configuration reference

| Field | Default | Notes |
|---|---|---|
| `vaultPath` | — (required) | folder to index; absolute, or relative to the config file |
| `includeGlobs` | `["**/*.md"]` | |
| `excludeGlobs` | `["**/node_modules/**"]` | |
| `ollamaUrl` | `http://localhost:11434` | |
| `embedModel` | `bge-m3` | any Ollama embedding model; changing it forces a rebuild |
| `indexPath` | `index.db` | relative to the config file; SQLite (WAL mode) |
| `topK` | `8` | default number of results |
| `serverName` | `docs-search` | MCP server name shown in the client |
| `toolDescription` | generic | tell the model what this knowledge base contains |

### Tuning retrieval

Five optional fields control what comes back (defaults in parentheses):

- `defaultExclude` (`["archive", "plans"]`) — path substrings skipped on every
  query. Callers opt back in per-query with `searchAll: true` (CLI: `--all`);
  the same flag re-includes docs marked `superseded`/`archived` in frontmatter.
- `minScore` (`0.55`) — absolute cosine floor. Below it, results are dropped and
  the tool answers "No relevant results" with the best rejected score, instead
  of returning noise. See the calibration report above for how to pick it.
- `relativeCutoff` (`0.88`) — drops results scoring below this fraction of the
  best surviving score.
- `lexicalMaxDocFreq` (`0.01`) — how rare a query term must be to trigger the
  lexical track: it qualifies if it appears in at most
  `max(5, ratio × total chunks)` chunks, and never if it appears in more than
  half the corpus. Raise it to let more terms through
  (more exact matches, more noise); lower it to reserve the track for genuinely
  unusual identifiers.
- `pathBoosts` (`{}`) — ordering-only multipliers by path substring, e.g.
  `{"reference/": 1.15, "decisions/": 1.1}` to prefer curated docs over notes.
  Boosts never override the thresholds and never change the reported score.

`minScore` and `relativeCutoff` ship tuned for `bge-m3`. On another model, run
`docs-rag index` and read the calibration line before trusting the defaults.

## How it works

Roughly 2,000 lines of TypeScript, no build magic, no framework. The retrieval
path proper — chunking, embedding, ranking — is about 500 of them, and you can
read it end to end.

- `src/chunk.ts` — splits markdown by heading, keeps the heading breadcrumb,
  collapses code fences out of the embedded text, splits oversized sections.
- `src/frontmatter.ts` — parses `status` / `date` / `superseded_by` and strips
  them from the indexed text.
- `src/embed.ts` + `src/models.ts` — Ollama's `/api/embed`, plus the per-model
  prefix registry.
- `src/store.ts` — SQLite schema, versioning, model identity, FTS5 mirror.
- `src/index-docs.ts` — walks the vault, chunks, embeds, writes incrementally.
- `src/calibrate.ts` — the noise-floor measurement behind the suggested
  `minScore`.
- `src/lexical.ts` — the rarity gate: which query terms deserve exact search.
- `src/search.ts` — embeds the query, ranks by cosine, applies thresholds,
  excludes and boosts, merges the lexical track.
- `src/server.ts` — the MCP server exposing `search_notes` over stdio.
- `src/scaffold.ts` — per-project instance generator.
- `src/hook.ts` — the auto re-index hook (debounce, locking, failure notices).
- `src/cli.ts` — the `docs-rag` executable; a subcommand table and nothing else.

## Deliberately out of scope

- Reciprocal-rank fusion for the two tracks. RRF discards the absolute score,
  and the absolute score is what `minScore` — the "I don't know" threshold —
  is built on. Keeping the tracks separate keeps that promise intact.
- Multiple vaults in a single instance (use multiple configs instead).
- Pluggable embedding providers — Ollama only, to keep the local-only promise.
- A human-facing UI, collaboration, multi-document synthesis. This exists so
  the agent working on your code knows your decisions, not as a place your team
  reads docs.

## License

MIT — see [LICENSE](LICENSE).
