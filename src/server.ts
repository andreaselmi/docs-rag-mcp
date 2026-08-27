// The MCP server. Exposes one tool, search_notes, over stdio.
// Register it at USER scope in your MCP client so it's available in every
// session regardless of the working directory: that decouples "where the
// agent is working" from "what it can recall".
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { search, noResultsMessage, metaLabel, viaLabel } from "./search.js";

// Everything lives inside main() — getConfig() included. At module top level it
// would run on import, so the CLI dispatching to ANY other subcommand would die
// on a missing config before that subcommand ever ran.
export async function main(): Promise<void> {
  const cfg = getConfig();
  const server = new McpServer({ name: cfg.serverName, version: "0.1.0" });

  server.tool(
    "search_notes",
    cfg.toolDescription,
    {
      query: z.string().describe("A natural-language question or topic"),
      k: z.number().optional().describe(`How many results to return (default ${cfg.topK})`),
      exclude: z
        .array(z.string())
        .optional()
        .describe(
          "Optional folder/path fragments to skip, e.g. [\"archive\"]. A section is " +
            "excluded when its file path contains any of these (case-insensitive). " +
            "Omit to search everything."
        ),
      searchAll: z
        .boolean()
        .optional()
        .describe(
          "Also search content excluded by default (archive/plans folders and docs marked " +
            "superseded/archived in frontmatter). Use only for explicitly historical questions."
        ),
    },
    async ({ query, k, exclude, searchAll }) => {
      const result = await search(query, k, exclude, searchAll);
      const empty = noResultsMessage(result, cfg.minScore, cfg.defaultExclude);
      if (empty !== null) {
        return { content: [{ type: "text", text: empty }] };
      }
      const text = result.hits
        .map((h, i) => {
          const label = metaLabel(h);
          return `## ${i + 1}. ${h.path}${h.heading ? " › " + h.heading : ""}  ${viaLabel(h)}${label ? "  " + label : ""}\n${h.text}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // IMPORTANT: never write to stdout in a stdio MCP server — only stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${cfg.serverName} MCP server running on stdio.`);
}

// Only run when executed directly (not when imported by the CLI or by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
