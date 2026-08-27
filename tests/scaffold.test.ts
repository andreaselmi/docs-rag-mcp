import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertMcpServers, mcpEntry, hookEntry, upsertHook, mergeConfig, resolveLauncher } from "../src/scaffold.js";

// The generated entries now come from a Launcher, not a path: this is what
// resolveLauncher produces in the local form, the only one with a path in it.
const local = (p: string) => ({ command: "node", args: [p] });

test("upsertMcpServers adds a server to an empty/absent config", () => {
  const out = upsertMcpServers(null, "docs-search", { command: "node" });
  assert.deepEqual(out, { mcpServers: { "docs-search": { command: "node" } } });
});

test("upsertMcpServers preserves other servers already registered", () => {
  const existing = {
    mcpServers: { other: { command: "foo" } },
    someTopLevelKey: true,
  };
  const out = upsertMcpServers(existing, "docs-search", { command: "node" });
  assert.deepEqual(out, {
    mcpServers: { other: { command: "foo" }, "docs-search": { command: "node" } },
    someTopLevelKey: true,
  });
});

test("upsertMcpServers replaces an entry with the same name", () => {
  const existing = { mcpServers: { "docs-search": { command: "old" } } };
  const out = upsertMcpServers(existing, "docs-search", { command: "new" });
  assert.deepEqual(out.mcpServers, { "docs-search": { command: "new" } });
});

test("mcpEntry points --config at a relative path (the server resolves it against CLAUDE_PROJECT_DIR)", () => {
  const entry = mcpEntry(local("/abs/install/dist/server.js")) as { command: string; args: string[] };
  assert.equal(entry.command, "node");
  // Relative, NOT ${CLAUDE_PROJECT_DIR}: Claude Code does not expand variables in
  // .mcp.json args. The server resolves the relative path against the
  // CLAUDE_PROJECT_DIR env var Claude Code injects (see resolveConfigPath).
  assert.deepEqual(entry.args, [
    "/abs/install/dist/server.js",
    "--config",
    ".rag/config.json",
  ]);
});

test("hookEntry: PostToolUse command entry with Write|Edit matcher and relative --config", () => {
  const e = hookEntry(local("/abs/install/dist/hook.js"));
  assert.equal(e.matcher, "Write|Edit");
  assert.equal(e.hooks.length, 1);
  assert.equal(e.hooks[0].type, "command");
  // Relative .rag/config.json: the hook resolves it against CLAUDE_PROJECT_DIR,
  // which Claude Code sets in the hook's environment (same logic as the server).
  assert.equal(e.hooks[0].command, 'node "/abs/install/dist/hook.js" --config .rag/config.json');
});

test("upsertHook: creates the hooks section from scratch", () => {
  const out = upsertHook(null, hookEntry(local("/i/dist/hook.js")));
  const post = (out.hooks as Record<string, unknown[]>).PostToolUse;
  assert.equal(post.length, 1);
});

test("upsertHook: preserves unrelated settings and other PostToolUse hooks", () => {
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }],
    },
  };
  const out = upsertHook(existing, hookEntry(local("/i/dist/hook.js")));
  const hooks = out.hooks as Record<string, unknown[]>;
  assert.equal(hooks.PostToolUse.length, 2);
  assert.deepEqual(out.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(hooks.Stop.length, 1);
});

test("upsertHook: running scaffold twice does not duplicate our entry", () => {
  const once = upsertHook(null, hookEntry(local("/i/dist/hook.js")));
  const twice = upsertHook(once, hookEntry(local("/i/dist/hook.js")));
  const post = (twice.hooks as Record<string, unknown[]>).PostToolUse;
  assert.equal(post.length, 1);
});

test("upsertHook: replaces our entry even if the install path changed", () => {
  const old = upsertHook(null, hookEntry(local("/old/place/dist/hook.js")));
  const moved = upsertHook(old, hookEntry(local("/new/place/dist/hook.js")));
  const post = (moved.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).PostToolUse;
  assert.equal(post.length, 1);
  assert.ok(post[0].hooks[0].command.includes("/new/place/"));
});

test("mergeConfig: no existing config -> the generated one, as is", () => {
  const gen = { vaultPath: "..", embedModel: "bge-m3" };
  assert.deepEqual(mergeConfig(null, gen), gen);
});

test("mergeConfig: an existing value always wins over the generated one", () => {
  const out = mergeConfig({ embedModel: "nomic-embed-text" }, { vaultPath: "..", embedModel: "bge-m3" });
  assert.equal(out.embedModel, "nomic-embed-text", "a choice already made is not overwritten");
  assert.equal(out.vaultPath, "..", "le chiavi mancanti si aggiungono");
});

test("mergeConfig: tuning keys the generator never writes survive untouched", () => {
  const tuned = {
    vaultPath: "..",
    pathBoosts: { "reference/": 1.15, "decisions/": 1.1 },
    minScore: 0.62,
    relativeCutoff: 0.9,
    defaultExclude: ["archive"],
    lexicalMaxDocFreq: 0.02,
  };
  const out = mergeConfig(tuned, { vaultPath: "..", pathBoosts: {}, embedModel: "bge-m3" });
  assert.deepEqual(out.pathBoosts, { "reference/": 1.15, "decisions/": 1.1 }, "the tuned pathBoosts does not go back to empty");
  assert.equal(out.minScore, 0.62);
  assert.equal(out.relativeCutoff, 0.9);
  assert.deepEqual(out.defaultExclude, ["archive"]);
  assert.equal(out.lexicalMaxDocFreq, 0.02);
  assert.equal(out.embedModel, "bge-m3", "a missing key is still added");
});

test("mergeConfig: an explicit empty pathBoosts is a choice, not an absence", () => {
  const out = mergeConfig({ pathBoosts: {} }, { pathBoosts: { "docs/": 1.2 } });
  assert.deepEqual(out.pathBoosts, {}, "present-but-empty stays present-but-empty");
});

test("mergeConfig: a key passed explicitly as a flag overrides the existing one", () => {
  const out = mergeConfig(
    { embedModel: "bge-m3", pathBoosts: { "reference/": 1.15 }, minScore: 0.62 },
    { embedModel: "nomic-embed-text", pathBoosts: {} },
    ["embedModel"]
  );
  assert.equal(out.embedModel, "nomic-embed-text", "the explicit flag wins");
  assert.deepEqual(out.pathBoosts, { "reference/": 1.15 }, "but it does not drag the rest along with it");
  assert.equal(out.minScore, 0.62);
});

test("mergeConfig: an override for a key the generator did not produce is ignored", () => {
  const out = mergeConfig({ minScore: 0.62 }, { vaultPath: ".." }, ["minScore"]);
  assert.equal(out.minScore, 0.62, "it does not invent a value that does not exist");
});

test("resolveLauncher: a global install is used by name, with no path at all", () => {
  const l = resolveLauncher("serve", { globalBin: true, distPath: "/i/dist/server.js", preferLocal: false });
  assert.deepEqual(l, { command: "docs-rag", args: ["serve"] });
});

test("resolveLauncher: with no global install it goes through npx", () => {
  const l = resolveLauncher("serve", { globalBin: false, distPath: "/i/dist/server.js", preferLocal: false });
  assert.deepEqual(l, { command: "npx", args: ["-y", "docs-rag-mcp", "serve"] });
});

test("resolveLauncher: preferLocal pins this checkout, even with a global install present", () => {
  const l = resolveLauncher("hook", { globalBin: true, distPath: "/i/dist/hook.js", preferLocal: true });
  assert.deepEqual(l, { command: "node", args: ["/i/dist/hook.js"] });
});

test("mcpEntry carries the launcher and always a relative --config", () => {
  assert.deepEqual(mcpEntry({ command: "npx", args: ["-y", "docs-rag-mcp", "serve"] }), {
    command: "npx",
    args: ["-y", "docs-rag-mcp", "serve", "--config", ".rag/config.json"],
  });
});

test("hookEntry quotes nothing it does not have to, and keeps the matcher", () => {
  const e = hookEntry({ command: "npx", args: ["-y", "docs-rag-mcp", "hook"] });
  assert.equal(e.matcher, "Write|Edit");
  assert.equal(e.hooks[0].command, "npx -y docs-rag-mcp hook --config .rag/config.json");
});

test("hookEntry quotes a local path, which may contain spaces", () => {
  const e = hookEntry(local("/My Install/dist/hook.js"));
  assert.equal(e.hooks[0].command, 'node "/My Install/dist/hook.js" --config .rag/config.json');
});

test("upsertHook still recognises the OLD node dist/hook.js entry and replaces it in place", () => {
  const old = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: 'node "/old/install/dist/hook.js" --config .rag/config.json' }],
        },
      ],
    },
  };
  const next = hookEntry({ command: "npx", args: ["-y", "docs-rag-mcp", "hook"] });
  const out = upsertHook(old, next);
  const post = (out.hooks as Record<string, unknown[]>).PostToolUse;
  assert.equal(post.length, 1, "replaced in place, not duplicated");
  assert.deepEqual(post[0], next);
});

test("upsertHook recognises the NEW entry too, so a re-scaffold is idempotent", () => {
  const entry = hookEntry({ command: "npx", args: ["-y", "docs-rag-mcp", "hook"] });
  const once = upsertHook(null, entry);
  const twice = upsertHook(once, entry);
  assert.equal(((twice.hooks as Record<string, unknown[]>).PostToolUse).length, 1);
});

test("upsertHook recognises the global-bin form, which does not name the package", () => {
  const entry = hookEntry({ command: "docs-rag", args: ["hook"] });
  const twice = upsertHook(upsertHook(null, entry), entry);
  assert.equal(((twice.hooks as Record<string, unknown[]>).PostToolUse).length, 1);
});

test("upsertHook leaves somebody else's PostToolUse hook alone", () => {
  const theirs = { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] };
  const out = upsertHook({ hooks: { PostToolUse: [theirs] } }, hookEntry({ command: "docs-rag", args: ["hook"] }));
  const post = (out.hooks as Record<string, unknown[]>).PostToolUse;
  assert.equal(post.length, 2);
  assert.deepEqual(post[0], theirs);
});
