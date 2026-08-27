import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrateMinScore } from "../src/calibrate.js";

// Mutually orthogonal vectors: the background noise is ~0, so the suggested
// threshold ends up on the lower clamp.
function orthogonal(n: number): Float32Array[] {
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(n);
    v[i] = 1;
    return v;
  });
}

test("returns null when there are too few vectors to sample", () => {
  assert.equal(calibrateMinScore(orthogonal(5)), null);
});

test("orthogonal vectors give a noise floor near zero and clamp the suggestion to 0.2", () => {
  const out = calibrateMinScore(orthogonal(40))!;
  assert.ok(out.noiseP99 < 0.05, `noiseP99 too high: ${out.noiseP99}`);
  assert.equal(out.suggested, 0.2);
  assert.ok(out.pairs > 0);
});

test("near-identical vectors give a high noise floor, clamped at 0.9", () => {
  const vs = Array.from({ length: 40 }, (_, i) => Float32Array.from([1, i * 0.0001]));
  const out = calibrateMinScore(vs)!;
  assert.ok(out.noiseP99 > 0.95, `noiseP99 too low: ${out.noiseP99}`);
  assert.equal(out.suggested, 0.9);
});

test("the same input always yields the same result (seeded sampling)", () => {
  const vs = orthogonal(60);
  assert.deepEqual(calibrateMinScore(vs), calibrateMinScore(vs));
});

// Pins the fix for the adjacent-index sampling bias: the original
// `if (i === j) j = (j + 1) % vectors.length` collision fix made index i+1 a
// systematically over-represented partner of i. Since vectors arrive in
// index order (consecutive chunks of the same document), that bias inflated
// the noise estimate with same-document pairs, pushing the suggested
// threshold too high.
//
// A "necklace" of vectors: index i shares a dedicated basis dimension with
// each of its two cyclic neighbors (i-1 and i+1), giving every adjacent pair
// cosine 0.5, while every non-adjacent pair is exactly orthogonal (cosine 0).
// At this size, a fair sample draws a neighbor pair for well under 1% of its
// draws, so p99 lands on the orthogonal floor (0) — but the old bias toward
// j = i+1 alone pushes the neighbor-pair rate over 1%, dragging p99 to 0.5.
function necklace(n: number): Float32Array[] {
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(n);
    v[(i - 1 + n) % n] = 1 / Math.SQRT2;
    v[i] = 1 / Math.SQRT2;
    return v;
  });
}

test("adjacent same-document-like pairs don't dominate the noise estimate", () => {
  const out = calibrateMinScore(necklace(250))!;
  assert.ok(out.noiseP99 < 0.1, `noiseP99 dragged up by adjacent bias: ${out.noiseP99}`);
  assert.equal(out.suggested, 0.2);
});
