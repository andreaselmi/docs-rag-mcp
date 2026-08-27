// Registry of embedding models. Replaces the hardcoded rule that lived in embed.ts:
// adding a model is a single line, not an `if` branch.
//
// Thresholds appear ONLY for models actually measured on a real corpus.
// A model absent from here remains fully usable: no prefix, and thresholds
// are provided by automatic calibration.

export interface ModelSpec {
  queryPrefix: string;
  documentPrefix: string;
  dim?: number;
  minScore?: number;
  relativeCutoff?: number;
}

const EMPTY: ModelSpec = { queryPrefix: "", documentPrefix: "" };

const REGISTRY: Record<string, ModelSpec> = {
  "bge-m3": { queryPrefix: "", documentPrefix: "", dim: 1024, minScore: 0.55, relativeCutoff: 0.88 },
  "nomic-embed-text": {
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
    dim: 768,
  },
};

// Ollama model names carry a tag ("bge-m3:latest"): match the part before the colon.
export function modelSpec(name: string): ModelSpec {
  const bare = name.split(":")[0];
  return REGISTRY[bare] ?? EMPTY;
}
