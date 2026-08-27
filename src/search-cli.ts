// Quick terminal test, so you can validate retrieval BEFORE wiring MCP.
// Usage:  docs-rag search "your question"  [--config /path/config.json] [--exclude a,b] [--all]
import { pathToFileURL } from "node:url";
import { search, noResultsMessage, metaLabel, viaLabel } from "./search.js";
import { getConfig } from "./config.js";

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i !== -1) args.splice(i, 2); // config is consumed by getConfig(); drop it from the query
  const e = args.indexOf("--exclude");
  let exclude: string[] | undefined;
  if (e !== -1) {
    exclude = (args[e + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    args.splice(e, 2); // drop --exclude and its value from the query
  }
  const a = args.indexOf("--all");
  const searchAll = a !== -1;
  if (searchAll) args.splice(a, 1); // drop --all from the query
  const q = args.join(" ").trim();
  if (!q) {
    console.error('Usage: docs-rag search "your question" [--config /path/config.json] [--exclude archive,drafts] [--all]');
    process.exit(1);
  }

  const cfg = getConfig();
  const result = await search(q, undefined, exclude, searchAll);
  const empty = noResultsMessage(result, cfg.minScore, cfg.defaultExclude);
  if (empty !== null) {
    console.log(empty);
  } else {
    for (const h of result.hits) {
      const label = metaLabel(h);
      console.log(`${viaLabel(h)}  ${h.path}${h.heading ? " › " + h.heading : ""}${label ? "  " + label : ""}`);
    }
  }
}

// Only run when executed directly (not when imported by the CLI or by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
