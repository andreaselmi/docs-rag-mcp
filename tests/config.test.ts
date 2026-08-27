import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfigPath, loadConfig, DEFAULTS } from "../src/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "docs-rag-mcp-test-"));
}

test("resolveConfigPath honors --config", () => {
  const p = resolveConfigPath(["--config", "/some/where/cfg.json"], "/root");
  assert.equal(p, resolve("/some/where/cfg.json"));
});

test("resolveConfigPath falls back to root config.json", () => {
  assert.equal(resolveConfigPath([], "/root"), resolve("/root", "config.json"));
});

test("resolveConfigPath rejects --config without a value", () => {
  assert.throws(() => resolveConfigPath(["--config"], "/root"), /--config requires a path/);
});

test("resolveConfigPath resolves a relative --config against CLAUDE_PROJECT_DIR", () => {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  try {
    // Claude Code sets this in the MCP server's env; a project-scoped .mcp.json
    // passes ".rag/config.json", which must land on the project root, not cwd.
    process.env.CLAUDE_PROJECT_DIR = "/proj/root";
    const p = resolveConfigPath(["--config", ".rag/config.json"], "/install");
    assert.equal(p, resolve("/proj/root", ".rag/config.json"));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test("resolveConfigPath: an absolute --config ignores CLAUDE_PROJECT_DIR", () => {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = "/proj/root";
    const p = resolveConfigPath(["--config", "/abs/cfg.json"], "/install");
    assert.equal(p, resolve("/abs/cfg.json"));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test("loadConfig applies defaults over a minimal config", () => {
  const dir = tmp();
  const vault = join(dir, "vault");
  mkdirSync(vault);
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ vaultPath: vault }));
  const cfg = loadConfig(cfgPath);
  assert.equal(cfg.vaultPath, vault);
  assert.deepEqual(cfg.includeGlobs, [...DEFAULTS.includeGlobs]);
  assert.deepEqual(cfg.excludeGlobs, [...DEFAULTS.excludeGlobs]);
  assert.equal(cfg.ollamaUrl, DEFAULTS.ollamaUrl);
  assert.equal(cfg.embedModel, DEFAULTS.embedModel);
  assert.equal(cfg.topK, DEFAULTS.topK);
  assert.equal(cfg.serverName, DEFAULTS.serverName);
  assert.equal(cfg.toolDescription, DEFAULTS.toolDescription);
});

test("relative indexPath and vaultPath resolve against the config file dir", () => {
  const dir = tmp();
  mkdirSync(join(dir, "vault"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ vaultPath: "vault", indexPath: "my-index.json" }));
  const cfg = loadConfig(cfgPath);
  assert.equal(cfg.vaultPath, join(dir, "vault"));
  assert.equal(cfg.indexPath, join(dir, "my-index.json"));
});

test("default indexPath is index.db next to the config", () => {
  const dir = tmp();
  mkdirSync(join(dir, "vault"));
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ vaultPath: "vault" }));
  assert.equal(loadConfig(cfgPath).indexPath, join(dir, "index.db"));
});

test("loadConfig fails clearly when the file is missing", () => {
  assert.throws(() => loadConfig("/nope/config.json"), /Config file not found/);
});

test("loadConfig fails clearly on invalid JSON", () => {
  const dir = tmp();
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, "{ not json");
  assert.throws(() => loadConfig(cfgPath), /Invalid JSON/);
});

test("loadConfig requires vaultPath", () => {
  const dir = tmp();
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({}));
  assert.throws(() => loadConfig(cfgPath), /vaultPath/);
});

test("loadConfig rejects a vaultPath that is not a directory", () => {
  const dir = tmp();
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ vaultPath: join(dir, "missing") }));
  assert.throws(() => loadConfig(cfgPath), /not a directory/);
});

test("loadConfig defaults the retrieval-quality fields", () => {
  const dir = tmp();
  const vault = join(dir, "vault");
  mkdirSync(vault);
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ vaultPath: vault }));
  const cfg = loadConfig(cfgPath);
  assert.deepEqual(cfg.defaultExclude, ["archive", "plans"]);
  assert.equal(cfg.minScore, 0.55);
  assert.equal(cfg.relativeCutoff, 0.88);
  assert.deepEqual(cfg.pathBoosts, {});
});

test("loadConfig honors overrides for the retrieval-quality fields", () => {
  const dir = tmp();
  const vault = join(dir, "vault");
  mkdirSync(vault);
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      vaultPath: vault,
      defaultExclude: [],
      minScore: 0.4,
      relativeCutoff: 0.9,
      pathBoosts: { "reference/": 1.2 },
    })
  );
  const cfg = loadConfig(cfgPath);
  assert.deepEqual(cfg.defaultExclude, []);
  assert.equal(cfg.minScore, 0.4);
  assert.equal(cfg.relativeCutoff, 0.9);
  assert.deepEqual(cfg.pathBoosts, { "reference/": 1.2 });
});

test("lexicalMaxDocFreq defaults to 0.01 and can be overridden", () => {
  const dir = tmp();
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ vaultPath: "vault" }));
  assert.equal(loadConfig(join(dir, "a.json")).lexicalMaxDocFreq, 0.01);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ vaultPath: "vault", lexicalMaxDocFreq: 0.05 }));
  assert.equal(loadConfig(join(dir, "b.json")).lexicalMaxDocFreq, 0.05);
});

test("explicitKeys distinguishes an absent key from one set to the default value", () => {
  const dir = tmp();
  mkdirSync(join(dir, "vault"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ vaultPath: "vault" }));
  assert.equal(loadConfig(join(dir, "a.json")).explicitKeys.includes("minScore"), false);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ vaultPath: "vault", minScore: 0.55 }));
  const cfg = loadConfig(join(dir, "b.json"));
  assert.equal(cfg.explicitKeys.includes("minScore"), true);
  assert.equal(cfg.minScore, 0.55);
});

test("resolveConfigPath: an absolute --config always wins", () => {
  const out = resolveConfigPath(["--config", "/abs/rag.json"], "/root", {
    cwd: "/somewhere",
    projectDir: "/project",
    exists: () => true,
  });
  assert.equal(out, "/abs/rag.json");
});

test("resolveConfigPath: CLAUDE_PROJECT_DIR wins over the cwd walk-up", () => {
  const out = resolveConfigPath(["--config", ".rag/config.json"], "/root", {
    cwd: "/a/b/c",
    projectDir: "/project",
    exists: (p) => p === "/a/b/.rag/config.json",
  });
  assert.equal(out, "/project/.rag/config.json");
});

test("resolveConfigPath: walks up from the cwd to the first ancestor that has it", () => {
  const out = resolveConfigPath(["--config", ".rag/config.json"], "/root", {
    cwd: "/a/b/c",
    projectDir: undefined,
    exists: (p) => p === "/a/.rag/config.json",
  });
  assert.equal(out, "/a/.rag/config.json");
});

test("resolveConfigPath: the cwd itself is the first candidate of the walk", () => {
  const out = resolveConfigPath(["--config", ".rag/config.json"], "/root", {
    cwd: "/a/b/c",
    projectDir: undefined,
    exists: (p) => p === "/a/b/c/.rag/config.json",
  });
  assert.equal(out, "/a/b/c/.rag/config.json");
});

test("resolveConfigPath: no ancestor has it -> falls back to the cwd, unchanged behaviour", () => {
  const out = resolveConfigPath(["--config", ".rag/config.json"], "/root", {
    cwd: "/a/b/c",
    projectDir: undefined,
    exists: () => false,
  });
  assert.equal(out, "/a/b/c/.rag/config.json");
});

test("resolveConfigPath: without --config it is still config.json next to the install", () => {
  const out = resolveConfigPath([], "/root", { cwd: "/a", projectDir: undefined, exists: () => false });
  assert.equal(out, "/root/config.json");
});

test("resolveConfigPath: --config without a value is an error", () => {
  assert.throws(() => resolveConfigPath(["--config"], "/root"), /requires a path/);
});

test("resolveConfigPath: with no --config it finds a project's .rag/config.json by walking up", () => {
  const out = resolveConfigPath([], "/install", {
    cwd: "/proj/docs/sub",
    projectDir: undefined,
    exists: (p) => p === "/proj/.rag/config.json",
  });
  assert.equal(out, "/proj/.rag/config.json");
});

test("resolveConfigPath: with no --config, CLAUDE_PROJECT_DIR names the project", () => {
  const out = resolveConfigPath([], "/install", {
    cwd: "/elsewhere",
    projectDir: "/proj",
    exists: (p) => p === "/proj/.rag/config.json",
  });
  assert.equal(out, "/proj/.rag/config.json");
});

test("resolveConfigPath: with no --config and no .rag anywhere, the install's config.json stays the fallback", () => {
  const out = resolveConfigPath([], "/install", {
    cwd: "/proj/docs",
    projectDir: undefined,
    exists: () => false,
  });
  assert.equal(out, "/install/config.json", "the from-source path, the one `docs-rag init` writes");
});

test("resolveConfigPath: a CLAUDE_PROJECT_DIR without .rag does not shadow the install fallback", () => {
  const out = resolveConfigPath([], "/install", {
    cwd: "/proj",
    projectDir: "/proj",
    exists: () => false,
  });
  assert.equal(out, "/install/config.json");
});
