// Calibration of the relevance threshold from the model's background noise.
//
// The problem: minScore 0.55 was tuned on bge-m3 and does not transfer.
// Different models compress scores differently — some put everything above
// 0.7. An inherited constant on a new model silently gives wrong results.
//
// The method: pairs of distinct chunks picked at random are, by
// construction, not relevant to each other. The distribution of their
// similarity IS the model's background noise on that corpus; the threshold
// must sit above it.
// Cost: zero calls to Ollama (the vectors are already in memory).

const MIN_VECTORS = 20; // below this, the sample says nothing
const DEFAULT_SAMPLE = 500;
const FLOOR = 0.2;
const CEILING = 0.9;

// LCG (numerical recipes): deterministic, so calibration is reproducible and
// tests don't depend on Math.random.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export function calibrateMinScore(
  vectors: Float32Array[],
  sampleSize: number = DEFAULT_SAMPLE,
  seed = 42
): { noiseP99: number; suggested: number; pairs: number } | null {
  if (vectors.length < MIN_VECTORS) return null;
  const rand = lcg(seed);
  const sims: number[] = [];
  for (let n = 0; n < sampleSize; n++) {
    const i = Math.floor(rand() * vectors.length);
    // Uniform over every index except i: no collision to fix, and no index
    // over-represented as i's partner. Adjacent chunks belong to the same
    // document and are more alike than a random pair, so biasing toward them
    // would inflate the noise estimate and push the threshold too high.
    const j = (i + 1 + Math.floor(rand() * (vectors.length - 1))) % vectors.length;
    if (vectors[i].length !== vectors[j].length) continue; // defensive
    sims.push(cosine(vectors[i], vectors[j]));
  }
  if (sims.length === 0) return null;
  sims.sort((a, b) => a - b);
  const noiseP99 = sims[Math.min(sims.length - 1, Math.floor(0.99 * sims.length))];
  const suggested = Math.min(CEILING, Math.max(FLOOR, Number(noiseP99.toFixed(2))));
  return { noiseP99, suggested, pairs: sims.length };
}
