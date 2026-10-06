import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder() {
  if (!embedderPromise) {
    // Downloads once (~90MB) and caches locally under ./.cache — no network needed after that
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2") as Promise<FeatureExtractionPipeline>;
  }
  return embedderPromise;
}

export async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  const vector = Array.from(output.data as Float32Array);

  // Defense in depth: only ever build vector-literal SQL from finite numbers (see rag.ts)
  if (vector.some((n) => !Number.isFinite(n))) {
    throw new Error("Embedding produced a non-finite value");
  }
  return vector;
}

export const EMBEDDING_DIM = 384;
