// Claude Code PostToolUse hook: keeps the project's index fresh by re-running
// the incremental indexer in the background after markdown edits.
//
// Three modes (decided in main() at the bottom):
//   (default)  hook event — reads the event JSON from stdin, decides
//   --sleeper  trailing run — waits out the debounce window, then runs
//   --run      wrapper — executes the indexer, logs, records the outcome
//
// The DECISIONS are pure functions (tested in tests/hook.test.ts); all IO
// lives in main() and the small helpers below it.
//
// Coalescing guarantee: at most one indexer run per DEBOUNCE_MS, and no edit
// is ever left behind — if events land inside the window, a single detached
// "sleeper" process performs one trailing run when the window expires.

export interface HookState {
  lastStart: number; // epoch ms of the last run start; 0 = never ran
  dirty: boolean; // edits arrived that the last run may not have seen
  running: boolean; // a --run wrapper is (believed to be) alive
  sleeperUntil: number | null; // wake time of the pending sleeper, if any
  notifiedFailure: boolean; // user already warned for the current episode
  lastRunOk: boolean; // outcome of the last completed run
}

export const DEBOUNCE_MS = 30_000;
// A "running" flag or sleeper older than this is a dead process (crash,
// kill, reboot) and must not block future runs forever.
export const STALE_RUN_MS = 600_000;

export const DEFAULT_STATE: HookState = {
  lastStart: 0,
  dirty: false,
  running: false,
  sleeperUntil: null,
  notifiedFailure: false,
  lastRunOk: true,
};

export type HookAction = "run" | "sleep" | "skip";

// Only markdown edits matter, and nothing under .rag/ may ever re-trigger
// the hook (the state file, log and index live there).
export function shouldTrigger(filePath: string | undefined): boolean {
  if (!filePath || !filePath.endsWith(".md")) return false;
  const norm = filePath.replace(/\\/g, "/");
  return !norm.includes("/.rag/") && !norm.startsWith(".rag/");
}

function runAlive(s: HookState, now: number): boolean {
  return s.running && now - s.lastStart < STALE_RUN_MS;
}

function sleeperAlive(s: HookState, now: number): boolean {
  return s.sleeperUntil !== null && now - s.sleeperUntil < STALE_RUN_MS;
}

// A hook event arrived (a .md file was written).
export function onEvent(
  state: HookState,
  now: number
): { action: HookAction; state: HookState } {
  const s: HookState = { ...state, dirty: true };
  const windowOpen = now - s.lastStart < DEBOUNCE_MS;
  if (runAlive(s, now) || windowOpen) {
    if (sleeperAlive(s, now)) return { action: "skip", state: s };
    const until = Math.max(s.lastStart + DEBOUNCE_MS, now);
    return { action: "sleep", state: { ...s, sleeperUntil: until } };
  }
  return {
    action: "run",
    state: { ...s, dirty: false, running: true, lastStart: now, sleeperUntil: null },
  };
}

// The sleeper woke up at (or after) its scheduled time.
export function onSleeperWake(
  state: HookState,
  now: number
): { action: HookAction; state: HookState } {
  const s: HookState = { ...state, sleeperUntil: null };
  if (!s.dirty) return { action: "skip", state: s };
  const windowOpen = now - s.lastStart < DEBOUNCE_MS;
  if (runAlive(s, now) || windowOpen) {
    const until = Math.max(s.lastStart + DEBOUNCE_MS, now + 1_000);
    return { action: "sleep", state: { ...s, sleeperUntil: until } };
  }
  return {
    action: "run",
    state: { ...s, dirty: false, running: true, lastStart: now },
  };
}

// Warn-once-per-episode logic. Called on every hook event with the result of
// a quick Ollama ping; also folds in the outcome of the last background run.
// The returned message (if any) goes to the user via the hook's stdout
// {"systemMessage": ...}; a successful state resets the flag so a NEW broken
// episode warns again.
export function failureNotice(
  state: HookState,
  pingOk: boolean
): { message: string | null; state: HookState } {
  const broken = !pingOk || !state.lastRunOk;
  if (!broken) return { message: null, state: { ...state, notifiedFailure: false } };
  if (state.notifiedFailure) return { message: null, state };
  const reason = !pingOk
    ? "Ollama is unreachable"
    : "the last background re-index failed";
  return {
    message: `docs-rag: ${reason} — the index is NOT updating (details: .rag/hook.log)`,
    state: { ...state, notifiedFailure: true },
  };
}

// ---------------------------------------------------------------------------
// IO section. Everything below is glue; keep logic OUT of here.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, openSync, closeSync, statSync, unlinkSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfigPath, loadConfig, projectRoot } from "./config.js";

function readState(statePath: string): HookState {
  try {
    if (!existsSync(statePath)) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(statePath: string, state: HookState): void {
  writeFileSync(statePath, JSON.stringify(state) + "\n");
}

async function pingOllama(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(300) });
    return res.ok;
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Spawn THIS script again, detached, in the given mode. The child owns its
// own lifetime; the hook process exits immediately so the session never waits.
function spawnDetached(mode: "--run" | "--sleeper", configPath: string): void {
  const self = fileURLToPath(import.meta.url);
  spawn(process.execPath, [self, mode, "--config", configPath], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// --run mode: execute the indexer, log everything, record the outcome.
function runIndexer(configPath: string, statePath: string, logPath: string): void {
  // Two hook events racing on the state file can both decide "run" and spawn
  // two wrappers. Only one may touch the index: claim an exclusive lock file;
  // the loser bows out (the winner's walk picks up every pending edit anyway).
  const lockPath = join(dirname(statePath), "hook-run.lock");
  try {
    closeSync(openSync(lockPath, "wx"));
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < STALE_RUN_MS) return process.exit(0);
      unlinkSync(lockPath); // stale lock: a previous wrapper died mid-run
      closeSync(openSync(lockPath, "wx"));
    } catch {
      return process.exit(0); // lost the takeover race too — someone else runs
    }
  }
  const fd = openSync(logPath, "w"); // truncate every run: no unbounded growth
  const indexer = resolve(projectRoot(), "dist/index-docs.js");
  const child = spawn(process.execPath, [indexer, "--config", configPath], {
    stdio: ["ignore", fd, fd],
  });
  child.on("exit", (code) => {
    try { unlinkSync(lockPath); } catch {} // release even if state write fails
    const st = readState(statePath);
    writeState(statePath, { ...st, running: false, lastRunOk: code === 0 });
    process.exit(0);
  });
}

// --sleeper mode: wait out the window, then act on what the state says.
async function sleeperLoop(configPath: string, statePath: string, logPath: string): Promise<void> {
  for (;;) {
    const until = readState(statePath).sleeperUntil;
    if (until === null) return;
    const wait = until - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const { action, state } = onSleeperWake(readState(statePath), Date.now());
    writeState(statePath, state);
    if (action === "run") return runIndexer(configPath, statePath, logPath);
    if (action === "skip") return;
    // action === "sleep": window moved (a run started meanwhile) — loop again
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = resolveConfigPath(argv, projectRoot());
  const ragDir = dirname(configPath);
  const statePath = join(ragDir, "hook-state.json");
  const logPath = join(ragDir, "hook.log");

  if (argv.includes("--run")) return runIndexer(configPath, statePath, logPath);
  if (argv.includes("--sleeper")) return sleeperLoop(configPath, statePath, logPath);

  // Hook event mode.
  let filePath: string | undefined;
  try {
    filePath = (JSON.parse(await readStdin()) as { tool_input?: { file_path?: string } })
      .tool_input?.file_path;
  } catch {
    return; // malformed event: not our problem, never disturb the session
  }
  if (!shouldTrigger(filePath)) return;

  const cfg = loadConfig(configPath); // throws only if the config vanished — caught below
  const pingOk = await pingOllama(cfg.ollamaUrl);
  let state = readState(statePath);

  if (!pingOk) {
    // Stay dirty so the next event after Ollama returns picks everything up.
    const { message, state: s } = failureNotice({ ...state, dirty: true }, false);
    writeState(statePath, s);
    if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + "\n");
    return;
  }

  const notice = failureNotice(state, true);
  state = notice.state;
  const { action, state: next } = onEvent(state, Date.now());
  writeState(statePath, next);
  if (notice.message)
    process.stdout.write(JSON.stringify({ systemMessage: notice.message }) + "\n");
  if (action === "run") spawnDetached("--run", configPath);
  else if (action === "sleep") spawnDetached("--sleeper", configPath);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0)); // a broken hook must NEVER break the session
}
