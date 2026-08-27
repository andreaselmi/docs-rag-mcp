// Configuration for docs-rag-mcp.
// Resolution order for the config file:
//   1. --config <path> on the command line (works on every entry point);
//      absolute wins, a relative path is resolved against CLAUDE_PROJECT_DIR
//      when set, else by walking up from the cwd (see resolveConfigPath)
//   2. config.json next to the project root (fallback)
// Relative paths inside the config (vaultPath, indexPath) resolve against
// the directory of the config file, so a config file "carries" its index
// and two instances never interfere.
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

export interface Config {
  vaultPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  ollamaUrl: string;
  embedModel: string;
  indexPath: string;
  topK: number;
  defaultExclude: string[];
  minScore: number;
  relativeCutoff: number;
  pathBoosts: Record<string, number>;
  serverName: string;
  toolDescription: string;
  lexicalMaxDocFreq: number;
  // Keys actually present in the file: tells "absent" apart from "set to the
  // default value". Threshold calibration must respect an explicit choice by
  // the user and only fill in an absence.
  explicitKeys: string[];
}

export const DEFAULTS = {
  includeGlobs: ["**/*.md"],
  excludeGlobs: ["**/node_modules/**"],
  ollamaUrl: "http://localhost:11434",
  embedModel: "bge-m3",
  indexPath: "index.db",
  topK: 8,
  defaultExclude: ["archive", "plans"],
  minScore: 0.55,
  relativeCutoff: 0.88,
  pathBoosts: {},
  serverName: "docs-search",
  toolDescription:
    "Semantic search over a local markdown knowledge base (notes, design docs, decisions). Use it to recall past context and decisions.",
  lexicalMaxDocFreq: 0.01,
} as const;

export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, ".."); // src/ (or dist/) -> project root
}

// Resolution order for a --config:
//   1. absolute path: always wins, works on every client
//   2. CLAUDE_PROJECT_DIR: Claude Code sets it in the MCP server's environment
//      to the project root, and it does NOT depend on the cwd (which no client
//      guarantees)
//   3. walk up from the cwd: the first ancestor where the relative path exists.
//      This is what makes ".rag/config.json" usable from Codex, Cursor or Zed,
//      none of which set an equivalent variable.
//   4. cwd, as before: if it exists nowhere, the error that follows must name
//      the path the user expected.
// Where `docs-rag scaffold` puts a project's config. Named once, because both
// the scaffold contract and the no-flag lookup have to agree on it.
export const PROJECT_CONFIG = ".rag/config.json";

export function resolveConfigPath(
  argv: string[],
  root: string,
  opts: { cwd?: string; projectDir?: string | undefined; exists?: (p: string) => boolean } = {}
): string {
  const cwd = opts.cwd ?? process.cwd();
  const projectDir = "projectDir" in opts ? opts.projectDir : process.env.CLAUDE_PROJECT_DIR;
  const fileExists = opts.exists ?? existsSync;

  // Walk from `from` up to the filesystem root, returning the first ancestor
  // where `rel` exists. This is what lets a relative config be found from any
  // subdirectory of a project, on clients that set no environment variable.
  const walkUp = (from: string, rel: string): string | null => {
    let dir = from;
    for (;;) {
      const candidate = resolve(dir, rel);
      if (fileExists(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  const i = argv.indexOf("--config");
  if (i === -1) {
    // No flag at all. `root` is the install directory, which for a published
    // package sits inside node_modules — a config.json there is meaningless.
    // So look for the project's own scaffolded config first, the same way a
    // relative --config is resolved, and keep root/config.json (what
    // `docs-rag init` writes when working from source) as the last resort.
    const scoped = PROJECT_CONFIG;
    if (projectDir && fileExists(resolve(projectDir, scoped))) return resolve(projectDir, scoped);
    return walkUp(cwd, scoped) ?? resolve(root, "config.json");
  }
  const p = argv[i + 1];
  if (!p) throw new Error("--config requires a path argument");
  if (isAbsolute(p)) return p;
  if (projectDir) return resolve(projectDir, p);
  // Not found anywhere: fall back to the cwd so the "not found" error names the
  // path the user expected, not one they never typed.
  return walkUp(cwd, p) ?? resolve(cwd, p);
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
        "Run `docs-rag init` to create one (or `yarn setup` from source), or point at an\n" +
        "existing one with --config <path>."
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON in ${configPath}: ${(e as Error).message}`);
  }
  if (typeof raw.vaultPath !== "string" || raw.vaultPath.length === 0) {
    throw new Error(`Missing required "vaultPath" in ${configPath}`);
  }
  const base = dirname(configPath);
  const vaultPath = resolve(base, raw.vaultPath);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error(`vaultPath is not a directory: ${vaultPath}`);
  }
  return {
    vaultPath,
    includeGlobs: (raw.includeGlobs as string[] | undefined) ?? [...DEFAULTS.includeGlobs],
    excludeGlobs: (raw.excludeGlobs as string[] | undefined) ?? [...DEFAULTS.excludeGlobs],
    ollamaUrl: (raw.ollamaUrl as string | undefined) ?? DEFAULTS.ollamaUrl,
    embedModel: (raw.embedModel as string | undefined) ?? DEFAULTS.embedModel,
    indexPath: resolve(base, (raw.indexPath as string | undefined) ?? DEFAULTS.indexPath),
    topK: (raw.topK as number | undefined) ?? DEFAULTS.topK,
    defaultExclude: (raw.defaultExclude as string[] | undefined) ?? [...DEFAULTS.defaultExclude],
    minScore: (raw.minScore as number | undefined) ?? DEFAULTS.minScore,
    relativeCutoff: (raw.relativeCutoff as number | undefined) ?? DEFAULTS.relativeCutoff,
    pathBoosts: (raw.pathBoosts as Record<string, number> | undefined) ?? { ...DEFAULTS.pathBoosts },
    serverName: (raw.serverName as string | undefined) ?? DEFAULTS.serverName,
    toolDescription: (raw.toolDescription as string | undefined) ?? DEFAULTS.toolDescription,
    lexicalMaxDocFreq: (raw.lexicalMaxDocFreq as number | undefined) ?? DEFAULTS.lexicalMaxDocFreq,
    explicitKeys: Object.keys(raw),
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) {
    cached = loadConfig(resolveConfigPath(process.argv.slice(2), projectRoot()));
  }
  return cached;
}
