# Setting up docs-rag-mcp

Ask the user before installing anything. Every step below runs locally. The only network access is npm (installing the package) and Ollama (pulling the model once).

## 1. Prerequisites

```
node -v                                  # must be >= 22.5 (uses built-in node:sqlite)
curl -s http://localhost:11434/api/tags  # Ollama running? lists pulled models
```

If Ollama is missing, the user installs it from https://ollama.com. Then:

```
ollama pull bge-m3
```

Ollama must be running **whenever the server is used**, not only at index time, because every query is embedded on the fly.

## 2. Install the CLI

```
npm i -g docs-rag-mcp@0.1.0
docs-rag --help
```

A global install makes `scaffold` write the short `docs-rag ...` command form, and the auto re-index hook starts instantly. Without it, use `npx -y docs-rag-mcp@0.1.0 <command>`.

## 3. Choose the setup

**Per project (usual case).** The knowledge base belongs to one repo:

```
docs-rag scaffold /path/to/project --name project-docs \
  --include "docs/**/*.md,adr/**/*.md" \
  --desc "Architecture decisions and specs for <project>" --hook --yes
docs-rag index --config /path/to/project/.rag/config.json
```

This writes:
- `.rag/config.json`
- a project-scoped `.mcp.json`, which is committable because it holds no machine paths
- `.gitignore` entries for the index
- with `--hook`, a Claude Code re-index hook in `.claude/settings.local.json`

`--desc` matters: the model reads it to decide whether to call the tool, so describe **what is in these docs**, not what the tool does.

**One personal knowledge base across all sessions:**

```
docs-rag init                                  # wizard -> config.json
docs-rag index --config /abs/path/config.json
claude mcp add my-notes -s user -- docs-rag serve --config /abs/path/config.json
```

**Other MCP clients** (Cursor, Codex CLI, Zed): use command `docs-rag` with args `["serve", "--config", "/absolute/path/to/.rag/config.json"]`. Use an absolute `--config`.

## 4. Verify

1. `docs-rag index` ends with a `Calibration:` line. If its suggested `minScore` is far above the configured one, tell the user their threshold admits noise.
2. `docs-rag search "<a topic you know is in the docs>"` returns the right section.
3. Restart the session or reload MCP. Claude Code asks the user to approve a new project-scoped `.mcp.json` server, so tell them to accept it. Then run `claude mcp list` (or `/mcp`) and check the server is connected.
4. Call `search_notes` once from the agent.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Connection refused on 11434 | Ollama not running. Run `ollama serve` or open the app. |
| Index refuses to open, says the model changed | `embedModel` changed. Re-run `docs-rag index` (full rebuild, expected). |
| `ExperimentalWarning: SQLite` | Harmless. |
| Hook warnings in session | See `.rag/hook.log`. Usually Ollama is down. |
| Everything returns "No relevant results" | Index empty (check `includeGlobs`) or wrong `--config`. |
