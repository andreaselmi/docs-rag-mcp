#!/usr/bin/env node
// The one published executable. It holds no domain logic: it maps a subcommand
// onto the module that implements it and hands over the rest of the command
// line. The `yarn` scripts still invoke those modules directly, so developing
// from source never goes through here.
//
//   docs-rag init | scaffold <dir> | index | search "..." | serve | hook

export const SUBCOMMANDS: Record<string, string> = {
  init: "./setup.js",        // interactive wizard -> config.json
  scaffold: "./scaffold.js", // scoped instance for one project
  index: "./index-docs.js",  // build or update the index
  search: "./search-cli.js", // query from the terminal
  serve: "./server.js",      // MCP server on stdio
  hook: "./hook.js",         // entry point Claude Code invokes
};

export function usage(): string {
  return [
    "Usage: docs-rag <command> [options]",
    "",
    "Commands:",
    "  init                 interactive wizard, writes config.json",
    "  scaffold <dir>       give a project its own scoped instance",
    "  index                build or update the index",
    '  search "question"    query the index from the terminal',
    "  serve                run the MCP server on stdio",
    "  hook                 Claude Code hook entry point (auto re-index)",
    "",
    "Every command accepts --config <path>. See README.md.",
  ].join("\n");
}

async function run(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h") {
    console.error(usage());
    process.exit(sub ? 0 : 1);
  }
  const mod = SUBCOMMANDS[sub];
  if (!mod) {
    console.error(`Unknown command: ${sub}\n\n${usage()}`);
    process.exit(1);
  }
  // The modules read process.argv.slice(2) themselves: dropping the subcommand
  // leaves them the exact command line they would see if invoked directly.
  process.argv = [process.argv[0], process.argv[1], ...rest];
  const { main } = (await import(mod)) as { main: () => Promise<void> | void };
  await main();
}

// The tests import this module to read SUBCOMMANDS; without the guard the
// import would run the dispatcher on the test runner's own arguments.
if (process.env.DOCS_RAG_NO_RUN !== "1") {
  await run();
}
