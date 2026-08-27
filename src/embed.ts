// Single point of contact with Ollama. Plain fetch, no SDK.
import { getConfig } from "./config.js";
import { modelSpec } from "./models.js";

function withPrefix(text: string, kind: "document" | "query"): string {
  const spec = modelSpec(getConfig().embedModel);
  return (kind === "query" ? spec.queryPrefix : spec.documentPrefix) + text;
}

async function call(input: string | string[]): Promise<number[][]> {
  const { ollamaUrl, embedModel } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embedModel, input }),
    });
  } catch {
    throw new Error(
      `Cannot reach Ollama at ${ollamaUrl}. Is Ollama running? ` +
        `Start it, then make sure the model is available: ollama pull ${embedModel}`
    );
  }
  if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// Single embedding (used for queries at search time).
export async function embed(text: string, kind: "document" | "query"): Promise<number[]> {
  const [vec] = await call(withPrefix(text, kind));
  return vec;
}

// Batched embedding (used by the indexer): one Ollama request for many chunks.
export async function embedBatch(texts: string[], kind: "document" | "query"): Promise<number[][]> {
  return call(texts.map((t) => withPrefix(t, kind)));
}
