import "server-only";

import { embeddingConfig } from "./config";

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Embed a single piece of text (the search query) using the configured
 * provider. Throws if the API key is missing or the request fails so the
 * caller can fall back to keyword search.
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (!embeddingConfig.apiKey) {
    throw new Error("OPENAI_API_KEY is not set — semantic search unavailable.");
  }

  const res = await fetch(`${embeddingConfig.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${embeddingConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingConfig.model,
      input: text,
      dimensions: embeddingConfig.dimensions,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as EmbeddingResponse;
  const vector = json.data?.[0]?.embedding;
  if (!vector) throw new Error("Embedding response had no vector.");
  return vector;
}
