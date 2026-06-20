// SPDX-License-Identifier: Apache-2.0

/**
 * Local inference for the search module — Transformers.js (ONNX), no Python
 * model server, no external API: indexed content never leaves the instance.
 *
 *   - Embeddings: `nomic-ai/nomic-embed-text-v1.5` (768 dims) — the same
 *     model the appstrate-ws spike runs through Onyx's Python model server,
 *     so retrieval quality carries over. Nomic REQUIRES task prefixes
 *     (`search_document:` / `search_query:`) — embedding without them
 *     degrades retrieval badly.
 *   - Reranking (optional, off by default): any ONNX cross-encoder via
 *     `SEARCH_RERANK_MODEL` (e.g. a bge-reranker-v2-m3 ONNX export for
 *     multilingual). Off by default because reranker weights are an extra
 *     several-hundred-MB download.
 *
 * Models download from the Hugging Face Hub on first use and are cached on
 * disk (override the location with `HF_HOME`; air-gapped instances pre-seed
 * the cache). Pipelines are lazy singletons — the API process only pays the
 * model load if a search actually needs it, and the worker-role process is
 * where indexing-time embedding runs.
 */

import {
  pipeline,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import type { Logger } from "@appstrate/core/logger";

export const EMBEDDING_DIMENSIONS = 768;
const EMBED_MODEL = process.env.SEARCH_EMBED_MODEL ?? "nomic-ai/nomic-embed-text-v1.5";
const RERANK_MODEL = process.env.SEARCH_RERANK_MODEL ?? "";
/** Batch size for indexing-time embedding (CPU-friendly). */
const EMBED_BATCH = 16;

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  embedderPromise ??= pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
  return embedderPromise;
}

// ---------------------------------------------------------------------------
// Real token counting for the chunker
// ---------------------------------------------------------------------------

let tokenizerPromise: Promise<Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>> | null =
  null;

/**
 * Token counter backed by the embedding model's OWN tokenizer, so chunk
 * budgets match what the model actually reads. The ≈4-chars approximation
 * under-counts French/accented text and code — a chunk sized with it can
 * exceed the model's window and get its tail silently truncated at embedding
 * time (content that would never be retrievable). The chunker takes the
 * counter as input precisely for this swap.
 */
export async function getTokenCounter(): Promise<(text: string) => number> {
  const tokenizer = await (tokenizerPromise ??= AutoTokenizer.from_pretrained(EMBED_MODEL));
  return (text: string) => tokenizer.encode(text).length;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const embedder = await getEmbedder();
  const output = await embedder(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

/** Embed document chunks (indexing time). */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map((t) => `search_document: ${t}`);
    out.push(...(await embedBatch(batch)));
  }
  return out;
}

/** Embed a search query (query time). */
export async function embedQuery(query: string): Promise<number[]> {
  const [vector] = await embedBatch([`search_query: ${query}`]);
  return vector!;
}

// ---------------------------------------------------------------------------
// Optional cross-encoder reranker
// ---------------------------------------------------------------------------

export function rerankerEnabled(): boolean {
  return RERANK_MODEL.length > 0;
}

interface RerankerHandles {
  // Transformers.js model/tokenizer classes are structurally typed here to
  // avoid leaking the library's generics into the module surface.
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}

let rerankerPromise: Promise<RerankerHandles> | null = null;

function getReranker(): Promise<RerankerHandles> {
  rerankerPromise ??= (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(RERANK_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
    ]);
    return { tokenizer, model };
  })();
  return rerankerPromise;
}

/**
 * Score (query, passage) pairs with the configured cross-encoder and return
 * candidate indices sorted by descending relevance. On any failure the caller
 * keeps its original order — reranking must never break search.
 */
export async function rerank(
  query: string,
  passages: string[],
  logger?: Logger,
): Promise<number[]> {
  const original = passages.map((_, i) => i);
  if (!rerankerEnabled() || passages.length === 0) return original;
  try {
    const { tokenizer, model } = await getReranker();
    const inputs = tokenizer(new Array<string>(passages.length).fill(query), {
      text_pair: passages,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const scores = (logits.sigmoid().tolist() as number[][]).map((row) => row[0] ?? 0);
    return original.sort((a, b) => scores[b]! - scores[a]!);
  } catch (err) {
    logger?.warn("reranker failed — keeping retrieval order", { err: String(err) });
    return original;
  }
}
