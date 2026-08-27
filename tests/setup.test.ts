import { test } from "node:test";
import assert from "node:assert/strict";
import { parseList } from "../src/setup.js";

test("parseList splits comma-separated values and trims", () => {
  assert.deepEqual(parseList(" a , b,c ", ["x"]), ["a", "b", "c"]);
});

test("parseList returns the fallback on empty input", () => {
  assert.deepEqual(parseList("", ["**/*.md"]), ["**/*.md"]);
  assert.deepEqual(parseList("  ,  ", ["**/*.md"]), ["**/*.md"]);
});
