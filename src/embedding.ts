// ============================================================
// Mycelium — Embedding service
// ============================================================
//
// Lazy singleton. Model: Xenova/all-MiniLM-L6-v2 (384 dims, ONNX quantized).

let pipeline: any = null;
let loadPromise: Promise<void> | null = null;
let modelId = "Xenova/all-MiniLM-L6-v2";
let dimension = 384;

export function configureEmbedding(model: string, dim: number): void {
  modelId = model;
  dimension = dim;
}

async function ensureLoaded(): Promise<void> {
  if (pipeline) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    console.log(`[mycelium] Loading embedding model: ${modelId}...`);
    const startTime = Date.now();

    const { pipeline: p } = await import("@xenova/transformers");
    pipeline = await p("feature-extraction", modelId, { quantized: true });

    console.log(`[mycelium] Embedding model loaded in ${Date.now() - startTime}ms`);
  })();

  await loadPromise;
}

export async function embedText(text: string): Promise<number[]> {
  await ensureLoaded();
  const output = await pipeline(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  await ensureLoaded();

  const output = await pipeline(texts, { pooling: "mean", normalize: true });
  const results: number[][] = [];
  const data = output.data as Float32Array;

  for (let i = 0; i < texts.length; i++) {
    const start = i * dimension;
    const end = start + dimension;
    results.push(Array.from(data.slice(start, end)));
  }

  return results;
}

export function isReady(): boolean {
  return pipeline !== null;
}

export function getDimension(): number {
  return dimension;
}
