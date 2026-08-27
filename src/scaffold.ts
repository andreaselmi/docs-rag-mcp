// Per-project generator. Turns any project folder into its own RAG instance:
// writes <project>/.rag/config.json and a project-scoped <project>/.mcp.json
// that Claude Code loads ONLY when you open that project. One shared install of
// this tool serves every project; each project carries its own config + index.
//
// Usage:
//   docs-rag scaffold <project-dir> [--name docs-search] [--include "**/*.md"]
//                               [--exclude "**/node_modules/**"] [--model bge-m3]
//                               [--desc "..."] [--hook] [--local] [--yes]
// Without --yes and on a TTY it asks for anything not passed as a flag.
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { DEFAULTS, projectRoot, PROJECT_CONFIG } from "./config.js";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// Merge a server entry into an existing .mcp.json object without dropping the
// other servers already registered there. Pure, so it is unit-tested.
export function upsertMcpServers(
  existing: McpConfig | null,
  name: string,
  entry: unknown
): McpConfig {
  const out: McpConfig = existing ? { ...existing } : {};
  out.mcpServers = { ...(out.mcpServers ?? {}), [name]: entry };
  return out;
}

// A re-scaffold must never wipe out tuning work. Someone who installs, tunes
// `pathBoosts` and the thresholds, then re-runs scaffold to change one glob
// would lose all of it silently: the worst case, because search keeps working,
// just worse, without saying anything.
// Rule: a key PRESENT in the file always wins, even when it is null or {}.
// Present-but-empty is a choice the user made, not an absence.
// The one exception is `override`: keys the user named explicitly on this run
// (`--model`, `--name`, ...). Without it, `scaffold --model X` on an already
// scaffolded project would do nothing at all and say nothing about it — the
// same silent-wrong this function exists to prevent, just pointing the other
// way.
export function mergeConfig(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
  override: string[] = []
): Record<string, unknown> {
  if (!existing) return generated;
  const forced: Record<string, unknown> = {};
  for (const k of override) if (k in generated) forced[k] = generated[k];
  return { ...generated, ...existing, ...forced };
}

export const PACKAGE_NAME = "docs-rag-mcp";
export const BIN_NAME = "docs-rag";

export interface Launcher {
  command: string;
  args: string[];
}

// How this tool is invoked inside the files we generate. Three forms, in
// precedence order:
//   preferLocal -> node <dist>: this checkout and no other. The right form when
//                  developing from source, and before the package is published
//                  — without it scaffold would emit an npx command that does
//                  not resolve.
//   globalBin   -> `docs-rag`: no path, no npx spawn, no latency. It matters
//                  most for the hook, which is designed to exit in zero
//                  seconds.
//   otherwise   -> npx: no machine-specific path, so .mcp.json becomes
//                  committable and whoever clones the repo gets search over the
//                  docs without installing anything by hand.
export function resolveLauncher(
  sub: string,
  opts: { globalBin: boolean; distPath: string; preferLocal: boolean }
): Launcher {
  if (opts.preferLocal) return { command: "node", args: [opts.distPath] };
  if (opts.globalBin) return { command: BIN_NAME, args: [sub] };
  return { command: "npx", args: ["-y", PACKAGE_NAME, sub] };
}

// --config stays RELATIVE in both entries: it resolves against
// CLAUDE_PROJECT_DIR when set, else by walking up from the cwd (see
// resolveConfigPath), so the same line works on Claude Code, Codex, Cursor or
// Zed. Do NOT write ${CLAUDE_PROJECT_DIR} into the args: Claude Code does not
// expand it there, it would be passed through literally.
export function mcpEntry(launcher: Launcher): unknown {
  return {
    command: launcher.command,
    args: [...launcher.args, "--config", PROJECT_CONFIG],
  };
}

// The PostToolUse entry for .claude/settings.local.json. Here the command is a
// shell string, not an array: only the pieces that can contain spaces need
// quoting, and that is the local path alone.
export function hookEntry(launcher: Launcher): {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
} {
  // Quote what is a path (it may contain spaces, and a bare path is the one
  // piece the shell can break on); leave subcommand tokens bare, so the npx
  // form reads exactly as you would type it.
  const quote = (a: string) => (/[\s"/]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const parts = [launcher.command, ...launcher.args.map(quote), "--config", PROJECT_CONFIG];
  return { matcher: "Write|Edit", hooks: [{ type: "command", command: parts.join(" ") }] };
}

// Merge our hook into an existing settings object without touching anything
// else. Identity: an entry naming this tool is ours (replaced in place);
// everything else is preserved. Idempotent by construction.
export function upsertHook(
  existing: Record<string, unknown> | null,
  entry: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = existing ? { ...existing } : {};
  const hooks = { ...((out.hooks as Record<string, unknown[]>) ?? {}) };
  const post = [...((hooks.PostToolUse as unknown[]) ?? [])];
  // Both command forms must be recognised — the old one embedded dist/hook.js,
  // the new one names the package or the bin. Recognising only one would
  // duplicate the entry on every re-scaffold.
  const ours = (e: unknown) => {
    const j = JSON.stringify(e);
    return j.includes("dist/hook.js") || j.includes(PACKAGE_NAME) || j.includes(BIN_NAME);
  };
  const i = post.findIndex(ours);
  if (i !== -1) post[i] = entry;
  else post.push(entry);
  hooks.PostToolUse = post;
  out.hooks = hooks;
  return out;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

function parseList(input: string | undefined, fallback: readonly string[]): string[] {
  if (input === undefined) return [...fallback];
  const items = input.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : [...fallback];
}

// Is `docs-rag` on the PATH? A question about the environment, so it stays out
// of the pure functions. `which` does not exist on Windows; a missing command
// counts as "no", which is the right fallback (npx works regardless).
function hasGlobalBin(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [BIN_NAME], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function main() {
  const argv = process.argv.slice(2);
  const positionals = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const targetArg = positionals[0];
  if (!targetArg) {
    console.error("Usage: docs-rag scaffold <project-dir> [--name ..] [--include ..] [--exclude ..] [--model ..] [--desc ..] [--hook] [--local] [--yes]");
    process.exit(1);
  }
  const projectDir = expandHome(targetArg);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    console.error(`Not an existing directory: ${projectDir}`);
    process.exit(1);
  }

  const yes = argv.includes("--yes");
  let hook = argv.includes("--hook");
  // Which command form to write into the generated files. `--local` pins it to
  // this checkout: the right form when developing from source, or until the
  // package is published. Otherwise prefer a global install when there is one
  // (no npx spawn), and fall back to npx.
  const preferLocal = argv.includes("--local");
  const globalBin = hasGlobalBin();
  const interactive = !yes && Boolean(process.stdin.isTTY);

  let name = flag(argv, "name") ?? DEFAULTS.serverName;
  let include = flag(argv, "include");
  let exclude = flag(argv, "exclude");
  let model = flag(argv, "model") ?? DEFAULTS.embedModel;
  let desc = flag(argv, "desc") ?? DEFAULTS.toolDescription;

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = async (q: string, def: string) => (await rl.question(`${q} [${def}]: `)).trim() || def;
    name = flag(argv, "name") ?? (await ask("MCP server name (shown in `claude mcp list`)", name));
    include = flag(argv, "include") ?? (await ask("Include globs (comma-separated)", DEFAULTS.includeGlobs.join(", ")));
    exclude = flag(argv, "exclude") ?? (await ask("Exclude globs (comma-separated)", DEFAULTS.excludeGlobs.join(", ")));
    model = flag(argv, "model") ?? (await ask("Embedding model", model));
    desc = flag(argv, "desc") ?? (await ask("Tool description (what's in THIS project's docs)", desc));
    if (!hook) {
      const a = await ask("Auto re-index on doc edits via Claude Code hook? (y/N)", "n");
      hook = a.toLowerCase().startsWith("y");
    }
    rl.close();
  }

  const includeGlobs = parseList(include, DEFAULTS.includeGlobs);
  const excludeGlobs = parseList(exclude, DEFAULTS.excludeGlobs);

  // 1) <project>/.rag/config.json — vaultPath "..".resolves to the project
  //    root; indexPath defaults to index.json next to this config, so the index
  //    lives at <project>/.rag/index.db. Fully self-contained.
  const ragDir = join(projectDir, ".rag");
  mkdirSync(ragDir, { recursive: true });
  const configPath = join(ragDir, "config.json");
  const generated = {
    vaultPath: "..",
    includeGlobs,
    excludeGlobs,
    pathBoosts: {},
    embedModel: model,
    serverName: name,
    toolDescription: desc,
  };
  let existingConfig: Record<string, unknown> | null = null;
  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      console.error(`Refusing to overwrite unparseable ${configPath}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  // Only the flags actually typed on this run may overwrite an existing value.
  const overrides = (
    [
      ["name", "serverName"],
      ["include", "includeGlobs"],
      ["exclude", "excludeGlobs"],
      ["model", "embedModel"],
      ["desc", "toolDescription"],
    ] as const
  )
    .filter(([f]) => flag(argv, f) !== undefined)
    .map(([, key]) => key as string);
  const config = mergeConfig(existingConfig, generated, overrides);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.error(
    existingConfig ? `Updated ${configPath} (existing settings preserved)` : `Wrote ${configPath}`
  );

  // 2) <project>/.mcp.json — project-scoped, so Claude loads it only in this repo.
  const serverPath = resolve(projectRoot(), "dist/server.js");
  const serverLauncher = resolveLauncher("serve", { globalBin, distPath: serverPath, preferLocal });
  const mcpPath = join(projectDir, ".mcp.json");
  let existing: McpConfig | null = null;
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, "utf8")) as McpConfig;
    } catch (e) {
      console.error(`Refusing to overwrite unparseable ${mcpPath}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const merged = upsertMcpServers(existing, name, mcpEntry(serverLauncher));
  writeFileSync(mcpPath, JSON.stringify(merged, null, 2) + "\n");
  console.error(`Wrote ${mcpPath} (server "${name}")`);

  // 2b) optional: Claude Code PostToolUse hook -> background incremental
  //     re-index on every markdown edit. Personal file (settings.local.json)
  //     because the command embeds this machine's absolute install path.
  if (hook) {
    const claudeDir = join(projectDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.local.json");
    let settings: Record<string, unknown> | null = null;
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      } catch (e) {
        console.error(`Refusing to overwrite unparseable ${settingsPath}: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    const hookScript = resolve(projectRoot(), "dist/hook.js");
    const hookLauncher = resolveLauncher("hook", { globalBin, distPath: hookScript, preferLocal });
    const withHook = upsertHook(settings, hookEntry(hookLauncher));
    writeFileSync(settingsPath, JSON.stringify(withHook, null, 2) + "\n");
    console.error(`Wrote ${settingsPath} (auto re-index hook; remove the PostToolUse entry to disable)`);
  }

  // 3) keep the generated index out of the project's git history.
  const giPath = join(projectDir, ".gitignore");
  const ignoreLines = [".rag/index.db*", ".rag/index.json", ".rag/index.json.bak"];
  if (hook) ignoreLines.push(".claude/settings.local.json");
  let current = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  for (const line of ignoreLines) {
    if (!current.split(/\r?\n/).includes(line)) {
      const prefix = current && !current.endsWith("\n") ? "\n" : "";
      current = current + prefix + line + "\n";
      console.error(`Added "${line}" to ${giPath}`);
    }
  }
  writeFileSync(giPath, current);

  if (preferLocal && !existsSync(serverPath)) {
    console.error(`\nNote: ${serverPath} is not built yet. Run \`yarn build\` in ${projectRoot()} once.`);
  }
  console.error("\nNext steps:");
  console.error(`  1. Build the index:  docs-rag index --config ${configPath}`);
  console.error(`  2. Open your MCP client in ${projectDir} — the "${name}" tool will be available there.`);
  console.error(`Tip: tune retrieval in ${configPath} — defaultExclude, minScore,`);
  console.error(`relativeCutoff, pathBoosts (e.g. {"reference/": 1.15}). See README "Tuning retrieval".`);
  console.error(`\nTip: retrieval quality depends on how your docs are structured.`);
  console.error(`See ${resolve(projectRoot(), "AUTHORING.md")} for how to write docs that search well.`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
