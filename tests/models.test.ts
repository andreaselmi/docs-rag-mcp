import { test } from "node:test";
import assert from "node:assert/strict";
import { modelSpec } from "../src/models.js";

test("bge-m3 wants no prefixes and carries measured thresholds", () => {
  const s = modelSpec("bge-m3");
  assert.equal(s.queryPrefix, "");
  assert.equal(s.documentPrefix, "");
  assert.equal(s.minScore, 0.55);
  assert.equal(s.dim, 1024);
});

test("the tag is ignored when matching a model name", () => {
  assert.deepEqual(modelSpec("bge-m3:latest"), modelSpec("bge-m3"));
});

test("nomic keeps its task prefixes", () => {
  const s = modelSpec("nomic-embed-text");
  assert.equal(s.queryPrefix, "search_query: ");
  assert.equal(s.documentPrefix, "search_document: ");
  assert.equal(s.dim, 768);
});

test("an unknown model gets no prefixes and no thresholds", () => {
  const s = modelSpec("some-new-model");
  assert.equal(s.queryPrefix, "");
  assert.equal(s.documentPrefix, "");
  assert.equal(s.minScore, undefined);
  assert.equal(s.dim, undefined);
});
