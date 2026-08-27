import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Must be set BEFORE the module is loaded, so the import is dynamic: importing
// cli.js runs its dispatcher unless this is in place.
process.env.DOCS_RAG_NO_RUN = "1";
const { SUBCOMMANDS, usage } = await import("../src/cli.js");

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

test("every documented subcommand maps to a module that exists", () => {
  for (const [sub, mod] of Object.entries(SUBCOMMANDS)) {
    const onDisk = resolve(SRC, mod.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
    assert.ok(existsSync(onDisk), `${sub} -> ${mod} does not exist (${onDisk})`);
  }
});

test("the subcommands are exactly the surface the README promises", () => {
  assert.deepEqual(Object.keys(SUBCOMMANDS).sort(), ["hook", "index", "init", "scaffold", "search", "serve"]);
});

test("usage names every subcommand, so an unknown one is self-explanatory", () => {
  const u = usage();
  for (const sub of Object.keys(SUBCOMMANDS)) assert.match(u, new RegExp(`\\b${sub}\\b`));
});

test("every subcommand module really exports a main()", async () => {
  for (const [sub, mod] of Object.entries(SUBCOMMANDS)) {
    const loaded = (await import(mod.replace("./", "../src/"))) as { main?: unknown };
    assert.equal(typeof loaded.main, "function", `${sub} does not export main()`);
  }
});
