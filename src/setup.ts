// Interactive onboarding: asks a few questions (Enter accepts the default),
// writes the config file, then verifies Ollama can embed with the chosen
// model. Run with:  docs-rag init  [--config /path/to/config.json]
import { createInterface } from "node:readline/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { DEFAULTS, projectRoot, resolveConfigPath } from "./config.js";

export function parseList(input: string, fallback: readonly string[]): string[] {
  const items = input.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : [...fallback];
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

export async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (q: string, def: string) => (await rl.question(`${q} [${def}]: `)).trim() || def;

  let vaultPath = "";
  while (true) {
    vaultPath = expandHome((await rl.question("Path to your vault (a folder of markdown files): ")).trim());
    if (vaultPath && existsSync(vaultPath) && statSync(vaultPath).isDirectory()) break;
    console.error("  Not an existing directory — try again.");
  }

  const includeGlobs = parseList(
    await ask("Include globs (comma-separated)", DEFAULTS.includeGlobs.join(", ")),
    DEFAULTS.includeGlobs
  );
  const excludeGlobs = parseList(
    await ask("Exclude globs (comma-separated)", DEFAULTS.excludeGlobs.join(", ")),
    DEFAULTS.excludeGlobs
  );
  const ollamaUrl = await ask("Ollama URL", DEFAULTS.ollamaUrl);
  const embedModel = await ask("Embedding model", DEFAULTS.embedModel);
  const serverName = await ask("MCP server name", DEFAULTS.serverName);

  const target = resolveConfigPath(process.argv.slice(2), projectRoot());
  if (existsSync(target)) {
    const ow = (await rl.question(`${target} already exists. Overwrite? [y/N]: `)).trim().toLowerCase();
    if (ow !== "y") {
      console.error("Aborted — existing config left untouched.");
      rl.close();
      return;
    }
  }
  rl.close();

  const config = { vaultPath, includeGlobs, excludeGlobs, ollamaUrl, embedModel, serverName };
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  console.error(`\nWrote ${target}`);

  // Verify Ollama end-to-end: try embedding a test string with the chosen model.
  try {
    const res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embedModel, input: "hello" }),
    });
    if (!res.ok) throw new Error(await res.text());
    console.error(`Ollama check OK (${embedModel}). Next step:  docs-rag index`);
  } catch {
    console.error(`Warning: could not embed with Ollama at ${ollamaUrl}.`);
    console.error("The config was written anyway. Before running `docs-rag index`:");
    console.error("  1. install and start Ollama (https://ollama.com)");
    console.error(`  2. pull the model:  ollama pull ${embedModel}`);
  }
}

// Only run interactively when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
