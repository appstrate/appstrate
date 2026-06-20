// SPDX-License-Identifier: MIT
// Lean port of onyx/indexing/chunker.py — sentence-aware chunking with a
// token budget, title prefix + metadata suffix capped at 25% of the chunk,
// no overlap. Ported from the appstrate-ws retrieval spike
// (packages/retrieval/src/chunker.ts), itself a TypeScript port of Onyx.
// Copyright (c) 2023-present DanswerAI, Inc. (MIT).

export const DEFAULT_MAX_CHUNK_SIZE = 512;
export const MAX_METADATA_PERCENTAGE = 0.25;
export const CHUNK_MIN_CONTENT = 256;
export const BLURB_SIZE = 128;
export const RETURN_SEPARATOR = "\n\r\n";

export type TokenCounter = (text: string) => number;

/**
 * Approximate token counter (≈4 chars/token). The embedding model's real
 * tokenizer is swapped in at indexing time (inference.ts) — the chunker API
 * takes the counter as input precisely for this swap.
 */
export const approximateTokens: TokenCounter = (text) => Math.ceil(text.length / 4);

export interface ChunkerInput {
  title: string | null;
  content: string;
  metadata?: Record<string, string | string[]>;
}

export interface DocAwareChunk {
  chunkIndex: number;
  /** Raw chunk text (without enrichment). */
  content: string;
  blurb: string;
  titlePrefix: string;
  metadataSuffixSemantic: string;
  metadataSuffixKeyword: string;
}

/** Indexed `content` field: title + content + keyword metadata variant. */
export function enrichedContentForIndex(chunk: DocAwareChunk): string {
  return `${chunk.titlePrefix}${chunk.content}${chunk.metadataSuffixKeyword}`;
}

export function metadataSuffixes(
  metadata: Record<string, string | string[]> | undefined,
  includeSeparator = false,
): { semantic: string; keyword: string } {
  if (!metadata || Object.keys(metadata).length === 0) return { semantic: "", keyword: "" };
  let semantic = "Metadata:\n";
  const values: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    const valueStr = Array.isArray(value) ? value.join(", ") : value;
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
    semantic += `\t${key} - ${valueStr}\n`;
  }
  const result = { semantic: semantic.trim(), keyword: values.join(" ") };
  if (includeSeparator) {
    return {
      semantic: RETURN_SEPARATOR + result.semantic,
      keyword: RETURN_SEPARATOR + result.keyword,
    };
  }
  return result;
}

/**
 * Sentence-aware splitter: split into sentences, pack greedily up to the
 * token budget, hard-split by words when a single sentence overflows.
 */
export function splitBySentences(
  text: string,
  tokenBudget: number,
  countTokens: TokenCounter,
): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  const pushPiece = (piece: string) => {
    const candidate = current ? `${current} ${piece}` : piece;
    if (countTokens(candidate) <= tokenBudget) {
      current = candidate;
      return;
    }
    flush();
    if (countTokens(piece) <= tokenBudget) {
      current = piece;
      return;
    }
    // A single overlong sentence: hard-split by words.
    let part = "";
    for (const word of piece.split(/\s+/)) {
      const next = part ? `${part} ${word}` : word;
      if (countTokens(next) > tokenBudget && part) {
        chunks.push(part);
        part = word;
      } else {
        part = next;
      }
    }
    current = part;
  };

  for (const sentence of sentences) pushPiece(sentence);
  flush();
  return chunks.length > 0 ? chunks : [text.trim()];
}

/** First sentence-aware piece within `blurbSize` tokens. */
export function extractBlurb(
  text: string,
  countTokens: TokenCounter,
  blurbSize = BLURB_SIZE,
): string {
  return splitBySentences(text, blurbSize, countTokens)[0] ?? "";
}

export interface ChunkerOptions {
  countTokens?: TokenCounter;
  chunkTokenLimit?: number;
  blurbSize?: number;
  includeMetadata?: boolean;
}

/** Port of Chunker._handle_single_document (lean). */
export function chunkDocument(doc: ChunkerInput, opts: ChunkerOptions = {}): DocAwareChunk[] {
  const countTokens = opts.countTokens ?? approximateTokens;
  const chunkTokenLimit = opts.chunkTokenLimit ?? DEFAULT_MAX_CHUNK_SIZE;
  const blurbSize = opts.blurbSize ?? BLURB_SIZE;
  const includeMetadata = opts.includeMetadata ?? true;

  const title = doc.title ? extractBlurb(doc.title, countTokens, blurbSize) : "";
  let titlePrefix = title ? title + RETURN_SEPARATOR : "";
  const titleTokens = countTokens(titlePrefix);

  const suffixes = includeMetadata
    ? metadataSuffixes(doc.metadata, true)
    : { semantic: "", keyword: "" };
  const metadataSuffixKeyword = suffixes.keyword;
  let metadataSuffixSemantic = suffixes.semantic;
  let metadataTokens = countTokens(metadataSuffixSemantic);

  // Metadata must never overwhelm the chunk content.
  if (metadataTokens >= chunkTokenLimit * MAX_METADATA_PERCENTAGE) {
    metadataSuffixSemantic = "";
    metadataTokens = 0;
  }

  let contentTokenLimit = chunkTokenLimit - titleTokens - metadataTokens;
  // Not enough room left for real content — index bare chunks instead.
  if (contentTokenLimit <= CHUNK_MIN_CONTENT) {
    contentTokenLimit = chunkTokenLimit;
    titlePrefix = "";
    metadataSuffixSemantic = "";
  }

  const pieces = splitBySentences(doc.content, contentTokenLimit, countTokens);
  return pieces.map((content, chunkIndex) => ({
    chunkIndex,
    content,
    blurb: extractBlurb(content, countTokens, blurbSize),
    titlePrefix,
    metadataSuffixSemantic,
    metadataSuffixKeyword,
  }));
}
