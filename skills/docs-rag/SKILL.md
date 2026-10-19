---
name: docs-rag
description: Use when a project's markdown docs, specs, ADRs or decision logs need to be searchable by meaning from the agent, when a search_notes tool (docs-rag-mcp) is connected, when its results carry labels like [semantic 0.71], [both], [exact match] or [superseded → ...], when it answers "No relevant results", or when a decision changes and the old doc must stop being treated as current.
---

# docs-rag

## Overview

`docs-rag-mcp` is a local MCP server (Ollama embeddings, SQLite, nothing leaves the machine) exposing one tool, `search_notes`, over a folder of markdown. Its point is not better recall but **truth freshness**: superseded docs are hidden, weak matches are refused instead of guessed, and every hit says why it was returned.

Your job with it: use what it returns as the current truth only when it says so, keep the lifecycle frontmatter honest when decisions change, and re-index after editing.

## When NOT to use

- Exact symbols, function names, error codes in **code**: grep is faster.
- A handful of docs: just read them.

## Setup

Not installed or not connected? Follow `references/setup.md` exactly. Do not guess env vars or config keys: the server reads a `config.json` produced by `docs-rag init` or `docs-rag scaffold`, nothing else. The default embedding model is `bge-m3`, and the thresholds are tuned for it.

## Reading results

| Label | Meaning | How to weigh it |
|---|---|---|
| `[semantic 0.712]` | matched by meaning, cosine score | Already passed `minScore` and the relative cutoff, so it's relevant. Still read the section before quoting it. |
| `[both 0.712]` | matched by meaning **and** rare exact terms | Strongest signal. |
| `[exact match]` | matched only on a rare literal term (error code, acronym) | No score on purpose. Reliable for that identifier, otherwise weak. |
| `[draft]` | `status: draft` doc | Not settled. Say so when you use it. |
| `[2026-01-14]` | doc date | Judge freshness. |
| `[superseded → path]` / `[archived]` | historical doc (only shown with `searchAll`) | **Never** use as the current answer. Open the successor `path`. |

**`No relevant results (best score X, threshold Y)`** means nothing in the docs answers this. That is an answer, not a malfunction. Do not lower thresholds or invent an answer. Instead:
1. Retry once with the words the docs would use (synonyms, the feature's name).
2. Check the code or ask the user.
3. Use `searchAll: true` in two cases only:
   - **Historical question** ("what did we decide before?", "why did we change X?"). The hits are the answer, labelled as history.
   - **Current question, and the message says default-excluded content had candidates.** Retry with `searchAll: true` only to find the pointer. From a `[superseded → path]` hit, take the `path`, open that successor doc and answer from it. If the successor is itself superseded, follow the chain. Never answer from the superseded body. If the hits are only `[archived]` with no successor, say the docs hold only historical material on this.

`searchAll` also includes the default-excluded folders (`defaultExclude` in the config, `archive` and `plans` by default). `exclude: ["drafts"]` skips path fragments for one query.

## When a decision changes

The tool understands exactly these frontmatter fields. Anything else (`accepted`, `supersedes`, `deprecated`, `title`) is ignored by the index:

```yaml
---
status: current        # current (default) | draft | superseded | archived
date: 2026-10-19       # ISO date of last substantive change
superseded_by: decisions/2026-10-session-length.md   # only with status: superseded
---
```

`superseded_by` is a path relative to the indexed folder (`vaultPath`, which is the project root for a scaffolded project).

Recording a new decision that replaces an old one:
1. Write the new doc next to the old one, following the folder's existing naming. It must match the config's `includeGlobs` (check `.rag/config.json`) and must not sit in a `defaultExclude` folder, otherwise it is never found. Give it `status: current` (or omit `status`) and today's `date`.
2. In the old doc, change only the frontmatter: `status: superseded` and `superseded_by: <new path>`. If it has no frontmatter, add a `---` block at the very top. Keep the body, because it's history.
3. Find docs whose `superseded_by` points at the old doc and repoint them to the new one, so no chain ends at a dead doc. To find them: `grep -rl "superseded_by: <old path>" <vault>`.
4. Plans or briefs that were carried out and have no successor get `status: archived`.
5. Re-index (see below). Until you do, search still returns the old truth.

When writing or restructuring docs, follow `references/authoring.md` (also published as `AUTHORING.md` in the docs-rag-mcp repo). Retrieval works per heading section, so every section has to stand on its own.

## Keeping the index fresh

After editing markdown, run `docs-rag index` (add `--config <path>` if not inside a scaffolded project). It is incremental and the running server picks it up without a restart. If the project was scaffolded with `--hook`, Claude Code re-indexes automatically after your edits.

To test a query outside MCP, run `docs-rag search "question"` (`--all`, `--exclude a,b`).

## Common mistakes

- Treating `No relevant results` as a bug and switching to `searchAll` or loosening `minScore` to get *something*.
- Quoting a `[superseded → …]` hit as the answer instead of the successor.
- Inventing frontmatter values (`status: accepted`) that the index silently ignores.
- Editing docs and searching again without re-indexing.
- Writing `${CLAUDE_PROJECT_DIR}` into `.mcp.json` args. Claude Code doesn't expand it there.
