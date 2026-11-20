// SPDX-License-Identifier: Apache-2.0

/**
 * The context gauge read against a model other than the one that measured it, and the
 * estimates the composer warns with: how a catalog row sizes a turn, whether the conversation
 * already exceeds a model, and what a draft's attachments add. Pure: the server's sizing
 * rules mirrored for the browser, which cannot import the runner.
 */

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  deriveResponseReserveTokens,
} from "@appstrate/core/token-budget";
import { isRasterImageMime } from "@appstrate/core/mime";
import { contextReading, type ConversationContext } from "./turn-context.ts";

/**
 * How far past a model's limit the last measure must be before the picker flags it. The measure
 * is the measuring model's tokenizer; another family's commonly counts the same text 10–20 %
 * apart, so a smaller margin would flag a model that in fact still fits.
 */
export const FIT_MARGIN = 1.2;

/** Pi's own image estimate (`ESTIMATED_IMAGE_CHARS` 4800 / 4 chars per token). */
export const IMAGE_TOKENS = 1_200;
/**
 * A natively read PDF goes out as each page's text plus its image (≈1.5k–3k tokens a page), and
 * a page usually weighs 20–100 KB: one token per 64 bytes stays at or under that, so the
 * estimate errs low. Only a heavy scan (one page well above 100 KB) is overestimated.
 */
export const PDF_BYTES_PER_TOKEN = 64;
/** `@appstrate/mcp-transport`'s `RESOURCE_BLOB_MAX_BYTES`: raw PDF bytes one turn sends, in all. */
export const PDF_TURN_MAX_BYTES = 700 * 1024;
/** The engine's per-message cap on images and on PDFs (`attachment-inputs.ts`). */
const FILES_PER_KIND = 4;
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
 * What the last measure already exceeds of a model, past {@link FIT_MARGIN} only. An assumed
 * window is never said exceeded: the model's real one is unknown. Its threshold still is, since
 * the engine summarizes at that fallback's threshold whatever the model's real window.
 */
export function modelFit(tokens: number, sizing: ModelSizing | null): ModelFit | null {
  if (!sizing) return null;
  if (!sizing.windowAssumed && tokens > sizing.window * FIT_MARGIN) return "window";
  if (tokens > sizing.compactAt * FIT_MARGIN) return "threshold";
  return null;
}

export interface DraftFile {
  name: string;
  mime: string;
  size: number;
}

/**
 * Tokens a draft's files add to the next request, as the engine sends them: every file as a
 * pointer line, an image's pixels only to a model that reads images, a PDF only to one that reads
 * PDFs and within the turn's byte cap. Any other file is its pointer alone: the model reads it
 * with a tool if it chooses to. `null` capabilities (not known) count nothing.
 */
export function estimateDraftTokens(
  files: readonly DraftFile[],
  model: { readsImages: boolean | null; readsPdf: boolean | null },
): number {
  let tokens = 0;
  let images = 0;
  let pdfs = 0;
  let pdfBytes = PDF_TURN_MAX_BYTES;
  for (const file of files) {
    tokens += Math.ceil((file.name.length + POINTER_LINE_CHARS) / 4);
    if (isRasterImageMime(file.mime)) {
      if (model.readsImages === true && images < FILES_PER_KIND) {
        images++;
        tokens += IMAGE_TOKENS;
      }
    } else if (file.mime === "application/pdf" && model.readsPdf === true) {
      if (pdfs < FILES_PER_KIND && file.size > 0 && file.size <= pdfBytes) {
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
