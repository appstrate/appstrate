// SPDX-License-Identifier: Apache-2.0

/**
 * The context gauge read against a model other than the one that measured it, and the
 * estimates the composer warns with: how a catalog row sizes a turn, whether the conversation
 * already exceeds a model, and what a draft adds. Pure: the server's sizing
 * rules mirrored for the browser, which cannot import the runner.
 */

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  deriveResponseReserveTokens,
} from "@appstrate/core/token-budget";
import { isRasterImageMime } from "@appstrate/core/mime";
import { FILES_PER_KIND_PER_MESSAGE, TURN_PDF_MAX_BYTES } from "../attachment-limits.ts";
import { contextReading, type ConversationContext } from "./turn-context.ts";

/**
 * Pi's own image estimate (`ESTIMATED_IMAGE_CHARS` 4800 / 4 chars per token). An approximation:
 * providers count an image differently (Gemini ≈258 tokens).
 */
const IMAGE_TOKENS = 1_200;
/**
 * A natively read PDF goes out as each page's text plus its image (≈1.5k–3k tokens a page), and
 * a page usually weighs 20–100 KB: one token per 64 bytes. An approximation: a heavy scan is
 * overestimated, a dense text page underestimated.
 */
const PDF_BYTES_PER_TOKEN = 64;
/** Pi's text estimate: four characters a token. */
const CHARS_PER_TOKEN = 4;
/** `[Attached file: <name> — appfile://file_… — <mime>, <size>]` without the name. */
const POINTER_LINE_CHARS = 80;

export interface ModelSizing {
  window: number;
  compactAt: number;
  /** The row declares no window: `window` is the engine's fallback. */
  windowAssumed?: true;
}

/**
 * The window and threshold the engine runs a model at, as `derivePiCompactionSettings` does from
 * `buildPiModel`'s defaults. `null` for an alias: the browser does not see its backing's limits.
 */
export function modelSizing(model: {
  aliased?: boolean;
  contextWindow?: number | null;
  maxTokens?: number | null;
}): ModelSizing | null {
  if (model.aliased) return null;
  const window = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserve = deriveResponseReserveTokens(window, model.maxTokens ?? DEFAULT_MAX_TOKENS);
  return {
    window,
    compactAt: window - reserve,
    ...(model.contextWindow == null ? { windowAssumed: true as const } : {}),
  };
}

export interface SelectedReading {
  context: ConversationContext;
  /** The measuring model's name when it is not the selected one. */
  measuredWith: string | null;
  /** The reading uses the selected model's window and threshold (the tokens stay measured). */
  readAgainstSelected: boolean;
}

/** The last measure, read against the selected model when it is another one whose sizing is known. */
export function selectedModelReading(
  measured: ConversationContext,
  selectedId: string | null | undefined,
  selected: ModelSizing | null | undefined,
): SelectedReading {
  const switched =
    measured.modelId !== null && selectedId != null && measured.modelId !== selectedId;
  if (!switched) return { context: measured, measuredWith: null, readAgainstSelected: false };
  if (!selected) {
    return { context: measured, measuredWith: measured.modelLabel, readAgainstSelected: false };
  }
  const { windowAssumed: _measuredAssumption, ...rest } = measured;
  const sized = { ...rest, ...selected };
  return {
    context: { ...sized, ...contextReading(sized) },
    measuredWith: measured.modelLabel,
    readAgainstSelected: true,
  };
}

/** `window`: it cannot take the history before a summary; `threshold`: it summarizes it first. */
export type ModelFit = "window" | "threshold";

/**
 * What the last measure already exceeds of a model, by the gauge's rule (`contextReading`). An
 * assumed window is never said exceeded: the model's real one is unknown. Its threshold still is,
 * since the engine summarizes at that fallback's threshold whatever the model's real window.
 */
export function modelFit(
  tokens: number,
  sizing: ModelSizing | null,
  crossModelEstimate = false,
): ModelFit | null {
  if (!sizing) return null;
  // Different tokenizers can disagree near a boundary. Warn on a cross-model estimate at 5% over.
  const exceeded = (limit: number) =>
    tokens > limit && (!crossModelEstimate || tokens - limit >= Math.ceil(limit * 0.05));
  if (!sizing.windowAssumed && exceeded(sizing.window)) return "window";
  if (exceeded(sizing.compactAt)) return "threshold";
  return null;
}

export interface DraftFile {
  name: string;
  mime: string;
  size: number;
}

/**
 * An estimate of the tokens a draft adds to the next request, as the engine sends it: its text,
 * every file as a pointer line, an image's pixels only to a model that reads images, a PDF only
 * to one that reads PDFs and within the turn's byte cap. Any other file is its pointer alone: the
 * model reads it with a tool if it chooses to. `null` capabilities (not known) count nothing.
 */
export function estimateDraftTokens(
  draft: { textLength: number; files: readonly DraftFile[] },
  model: { readsImages: boolean | null; readsPdf: boolean | null },
): number {
  let tokens = Math.ceil(draft.textLength / CHARS_PER_TOKEN);
  let images = 0;
  let pdfs = 0;
  let pdfBytes = TURN_PDF_MAX_BYTES;
  for (const file of draft.files) {
    tokens += Math.ceil((file.name.length + POINTER_LINE_CHARS) / CHARS_PER_TOKEN);
    if (isRasterImageMime(file.mime)) {
      if (model.readsImages === true && images < FILES_PER_KIND_PER_MESSAGE) {
        images++;
        tokens += IMAGE_TOKENS;
      }
    } else if (file.mime === "application/pdf" && model.readsPdf === true) {
      if (pdfs < FILES_PER_KIND_PER_MESSAGE && file.size > 0 && file.size <= pdfBytes) {
        pdfs++;
        pdfBytes -= file.size;
        tokens += Math.floor(file.size / PDF_BYTES_PER_TOKEN);
      }
    }
  }
  return tokens;
}

/** The draft would take a conversation still under the threshold past it. */
export function draftCrossesThreshold(
  context: Pick<ConversationContext, "tokens" | "compactAt">,
  draftTokens: number,
): boolean {
  return context.tokens <= context.compactAt && context.tokens + draftTokens > context.compactAt;
}
