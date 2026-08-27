import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/frontmatter.js";

const DEFAULTS = { status: "current", date: null, supersededBy: null };

test("no frontmatter: defaults, body untouched, no warning", () => {
  const md = "# Title\n\nSome prose here.";
  assert.deepEqual(parseFrontmatter(md), { meta: DEFAULTS, body: md, warning: null });
});

test("full frontmatter: parsed and stripped from the body", () => {
  const md = `---\nstatus: superseded\ndate: 2026-03-01\nsuperseded_by: reference/auth.md\n---\n# Old auth plan\n\nBody.`;
  const { meta, body, warning } = parseFrontmatter(md);
  assert.deepEqual(meta, { status: "superseded", date: "2026-03-01", supersededBy: "reference/auth.md" });
  assert.equal(body, "# Old auth plan\n\nBody.");
  assert.equal(warning, null);
});

test("out-of-enum status: current + warning", () => {
  const { meta, warning } = parseFrontmatter(`---\nstatus: wip\n---\nBody.`);
  assert.equal(meta.status, "current");
  assert.match(warning ?? "", /wip/);
});

test("unknown keys are ignored without error", () => {
  const { meta, body } = parseFrontmatter(`---\nauthor: someone\ntags: a, b\ndate: 2026-01-15\n---\nBody.`);
  assert.deepEqual(meta, { status: "current", date: "2026-01-15", supersededBy: null });
  assert.equal(body, "Body.");
});

test("unclosed frontmatter: treated entirely as body, no crash", () => {
  const md = `---\nstatus: archived\nno closing delimiter here`;
  assert.deepEqual(parseFrontmatter(md), { meta: DEFAULTS, body: md, warning: null });
});

test("empty frontmatter block: defaults, body stripped of the block", () => {
  const { meta, body } = parseFrontmatter(`---\n---\nBody.`);
  assert.deepEqual(meta, DEFAULTS);
  assert.equal(body, "Body.");
});

test("quoted values are unquoted", () => {
  const { meta } = parseFrontmatter(`---\ndate: "2026-03-01"\nsuperseded_by: 'reference/x.md'\n---\nBody.`);
  assert.equal(meta.date, "2026-03-01");
  assert.equal(meta.supersededBy, "reference/x.md");
});
