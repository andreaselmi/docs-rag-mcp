import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, MIN_BODY_CHARS, MAX_CHUNK_CHARS } from "../src/chunk.js";

const PROSE = "This paragraph explains the topic in enough detail to stay indexed.";

test("baseline: one chunk per heading-section with breadcrumb, heading line kept in text", () => {
  const md = `# Guide\n\n${PROSE}\n\n## Setup\n\n${PROSE}`;
  const chunks = chunkMarkdown(md);
  assert.deepEqual(chunks.map((c) => c.heading), ["Guide", "Guide > Setup"]);
  assert.ok(chunks[0].text.startsWith("# Guide"));
  assert.ok(chunks[1].text.startsWith("## Setup"));
});

test("a bash comment inside a fence does not split the section", () => {
  const md = `## Install\n\n${PROSE}\n\n\`\`\`bash\n# not a heading\necho hi\n\`\`\`\n\nAfter the code block the same section continues here.`;
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "Install");
  assert.ok(chunks[0].text.includes("# not a heading"));
  assert.ok(chunks[0].text.includes("After the code block"));
});

test("heading-only sections produce no chunk; their title survives in children breadcrumbs", () => {
  const md = `# Spec\n\n## Architecture\n\n### Frontend part\n\n${PROSE}`;
  const chunks = chunkMarkdown(md);
  assert.deepEqual(chunks.map((c) => c.heading), ["Spec > Architecture > Frontend part"]);
});

test("a tiny body below MIN_BODY_CHARS is dropped, one at the threshold is kept", () => {
  const tiny = "TBD";
  const exact = "x".repeat(MIN_BODY_CHARS);
  const chunks = chunkMarkdown(`## Small\n${tiny}\n\n## Kept\n${exact}`);
  assert.deepEqual(chunks.map((c) => c.heading), ["Kept"]);
});

test("content before the first heading is chunked with empty breadcrumb", () => {
  const chunks = chunkMarkdown(`${PROSE}\n\n# Title\n\n${PROSE}`);
  assert.deepEqual(chunks.map((c) => c.heading), ["", "Title"]);
});

test("a fence left open at EOF does not crash and stays in its section", () => {
  const md = `## Broken\n\n${PROSE}\n\n\`\`\`js\nconst x = 1;\n# also not a heading`;
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes("const x = 1;"));
});

test("~~~ fences behave like backtick fences", () => {
  const md = `## Tilde\n\n${PROSE}\n\n~~~\n# not a heading\n~~~`;
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
});

test("embedText equals text for prose-only sections", () => {
  const chunks = chunkMarkdown(`## Plain\n\n${PROSE}`);
  assert.equal(chunks[0].embedText, chunks[0].text);
});

test("embedText collapses a fenced block to a [code: lang] marker, text keeps it verbatim", () => {
  const md = `## Example\n\n${PROSE}\n\n\`\`\`rust\nfn main() { println!(\"hi\"); }\n\`\`\``;
  const [c] = chunkMarkdown(md);
  assert.ok(c.text.includes("fn main()"));
  assert.ok(c.embedText.includes("[code: rust]"));
  assert.ok(!c.embedText.includes("fn main()"));
  assert.ok(!c.embedText.includes("```"));
});

test("a fence without language collapses to [code]; inline code survives", () => {
  const md = "## Inline\n\nUse `yarn index` to rebuild everything now.\n\n```\nraw block\n```";
  const [c] = chunkMarkdown(md);
  assert.ok(c.embedText.includes("[code]"));
  assert.ok(c.embedText.includes("`yarn index`"));
  assert.ok(!c.embedText.includes("raw block"));
});

test("a section with only a code block (>30 chars) is kept and findable via the marker", () => {
  const md = "## Snippet only\n\n```ts\nconst configuration = { retries: 3, backoff: \"exponential\" };\n```";
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].embedText.includes("[code: ts]"), true);
});

test("oversized sections split at paragraph boundaries with (part i/N) headings", () => {
  const para = "word ".repeat(160).trim(); // ~800 chars
  const md = `## Long\n\n${para}\n\n${para}\n\n${para}`;
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].heading, `Long (part 1/${chunks.length})`);
  assert.equal(chunks[chunks.length - 1].heading, `Long (part ${chunks.length}/${chunks.length})`);
  const total = chunks.map((c) => c.text).join("\n\n");
  assert.ok(total.includes("## Long"));
  // no content lost: every paragraph appears exactly once across the parts
  assert.equal(total.split(para).length - 1, 3);
});

test("a split never lands inside a fence", () => {
  const bigCode = "line();\n".repeat(120); // ~960 chars of code
  const md = `## Mixed\n\nIntro paragraph long enough to matter for the split logic here.\n\n\`\`\`js\n${bigCode}\`\`\`\n\nOutro paragraph long enough to matter for the split logic too.\n\n${"filler ".repeat(200)}`;
  const chunks = chunkMarkdown(md);
  for (const c of chunks) {
    const opens = (c.text.match(/^```/gm) ?? []).length;
    assert.equal(opens % 2, 0, `unbalanced fence in part: ${c.heading}`);
  }
});

test("a section under the cap stays whole with its original heading", () => {
  const md = `## Short\n\n${PROSE}`;
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "Short");
});

test("a single paragraph larger than the cap stays intact (never mid-split)", () => {
  const giant = "x".repeat(MAX_CHUNK_CHARS + 500);
  const chunks = chunkMarkdown(`## Giant\n\n${giant}\n\nsmall trailing paragraph of reasonable length here`);
  const withGiant = chunks.find((c) => c.text.includes(giant));
  assert.ok(withGiant, "the giant paragraph must survive intact in one part");
  // the heading line must not become a heading-only "part 1" of its own
  for (const c of chunks) assert.ok(c.text.length >= MIN_BODY_CHARS, `part too small: ${JSON.stringify(c.text)}`);
});
