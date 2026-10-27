// SPDX-License-Identifier: Apache-2.0

/**
 * Keep inline tool-result images from piling up in every LLM request.
 *
 * An image a tool returns stays in the session for the whole run, and every
 * later request re-sends it. Pi re-encodes resized tool-result images PNG-first
 * (`normalizeToolResultImages`), so one photo thumbnail can sit in history as
 * ~2 MB of base64, and a handful of them reach the sidecar `/llm` proxy's
 * 10 MiB body cap, which fails the run with a non-retryable 413 (#2111).
 *
 * Rule, applied to what is SENT only (Pi's `context` event; the session keeps
 * every image): walking newest → oldest, tool-result images are kept while the
 * cumulative size of their base64 `data` stays within
 * {@link INLINE_IMAGE_BUDGET_BYTES}; the newest image is always kept. From the
 * first image that does not fit, it and every older one are replaced by a short
 * text block. User-message images are never touched. MCP images keep their
 * bytes on disk: they are saved under `resources/` and the pointer next to each
 * one names the file (`runtime-tools/resource-spill.ts`).
 *
 * The budget bounds the OLDER images only: the newest is always sent whatever
 * its size (Pi keeps the unprocessed original when its resize fails), so one
 * huge image can still hit the 413 — this does not fully solve #2111.
 *
 * A turn that drops an image returns a new list, so Pi re-emits the system
 * messages as one leading head (`restoreSystemMessages`, extensions/runner.js):
 * that turn also rewrites the prompt prefix.
 */

import type { ExtensionFactory } from "./pi-sdk.ts";

/** Base64 bytes of tool-result images sent inline in one request. */
const INLINE_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;

const OMITTED_IMAGE_TEXT =
  "[image omitted from this request to keep it small — to see it again, read its saved file if the result names one, or call the tool again]";

type ImageBlock = { type: "image"; data: string };

function isImageBlock(block: unknown): block is ImageBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

/**
 * Replace the tool-result images beyond the budget with a text block. Returns
 * `undefined` when nothing is dropped; never mutates `messages`.
 */
export function dropOldInlineImages<M extends { role: string }>(
  messages: readonly M[],
  budget: number = INLINE_IMAGE_BUDGET_BYTES,
): M[] | undefined {
  // Newest-first with a cut-off: later turns only add newer images, so the
  // cut-off only moves forward and a dropped image never comes back. Once the
  // budget is reached, each new image moves the cut-off, so in a
  // screenshot-per-turn loop the provider prompt cache breaks from the newly
  // dropped image onward on nearly every turn.
  let used = 0;
  let seen = false;
  let full = false;
  let out: M[] | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "toolResult") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    let next: unknown[] | undefined;
    for (let j = content.length - 1; j >= 0; j--) {
      const block: unknown = content[j];
      if (!isImageBlock(block)) continue;
      if (!full && (!seen || used + block.data.length <= budget)) {
        used += block.data.length;
        seen = true;
        continue;
      }
      full = true;
      next ??= content.slice();
      next[j] = { type: "text", text: OMITTED_IMAGE_TEXT };
    }
    if (next) {
      out ??= messages.slice();
      out[i] = { ...message, content: next };
    }
  }
  return out;
}

/** Pi extension applying {@link dropOldInlineImages} before every LLM call. */
export const inlineImageBudgetExtension: ExtensionFactory = (pi) => {
  pi.on("context", (event) => {
    const messages = dropOldInlineImages(event.messages);
    return messages ? { messages } : undefined;
  });
};
