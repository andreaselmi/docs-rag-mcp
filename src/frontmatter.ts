// Parses the optional frontmatter block at the top of a markdown doc and
// strips it from the body, so metadata never pollutes embeddings or results.
// Deliberately flat — `key: value` scalars between two `---` lines, nothing
// else. Three known keys; a YAML library would be overkill and this repo is
// zero-dependency by design.
export type DocStatus = "current" | "draft" | "superseded" | "archived";

export interface DocMeta {
  status: DocStatus;
  date: string | null; // as written (expected ISO YYYY-MM-DD); not validated
  supersededBy: string | null; // vault-relative path of the successor doc
}

export interface ParsedDoc {
  meta: DocMeta;
  body: string; // the markdown without the frontmatter block
  warning: string | null; // e.g. out-of-enum status; caller logs it
}

const STATUSES = ["current", "draft", "superseded", "archived"] as const;

export function parseFrontmatter(md: string): ParsedDoc {
  const meta: DocMeta = { status: "current", date: null, supersededBy: null };
  const lines = md.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { meta, body: md, warning: null };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return { meta, body: md, warning: null }; // unclosed -> all body

  let warning: string | null = null;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "status") {
      if ((STATUSES as readonly string[]).includes(value)) {
        meta.status = value as DocStatus;
      } else {
        warning = `Unknown status "${value}" — treating as current`;
      }
    } else if (key === "date") {
      meta.date = value || null;
    } else if (key === "superseded_by") {
      meta.supersededBy = value || null;
    }
  }
  return { meta, body: lines.slice(end + 1).join("\n"), warning };
}
