// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap (LLM-gateway alias pattern) — the inference-data-path half
 * of issue #727. The agent container is handed the public alias as its
 * `MODEL_ID`, so every request arrives with `model: <alias>`; the sidecar
 * rewrites it to the real upstream id before forwarding, and rewrites the
 * provider's echoed `model: <real>` back to the alias on the way out (non-stream
 * JSON AND streaming SSE). The agent therefore only ever sees the alias.
 *
 * Matching is by EXACT value at the known JSON locations, never a blind string
 * replace — so a model id that happens to appear inside generated content is
 * never clobbered. Known locations:
 *   - top-level `model` — OpenAI (request, chunk, completion) + Anthropic
 *     (request, non-stream Message),
 *   - `message.model` — Anthropic streaming `message_start` event.
 */

import type { ModelSwap } from "./helpers.ts";

/**
 * Rewrite the request body's top-level `model` alias→real. Returns the input
 * unchanged when it isn't JSON or the field isn't the alias (defensive: a
 * mismatch means the agent sent something unexpected — forward it verbatim
 * rather than corrupt the body).
 */
export function swapRequestModel(bodyText: string, swap: ModelSwap): string {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    if (obj && typeof obj === "object" && obj["model"] === swap.alias) {
      obj["model"] = swap.real;
      return JSON.stringify(obj);
    }
  } catch {
    // Not JSON — pass through untouched.
  }
  return bodyText;
}

/** Rewrite the known `model` locations real→alias in a parsed object (mutates). */
function rewriteModelRealToAlias(obj: unknown, swap: ModelSwap): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o["model"] === swap.real) o["model"] = swap.alias;
  const msg = o["message"];
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (m["model"] === swap.real) m["model"] = swap.alias;
  }
}

/**
 * Rewrite a non-stream JSON response body's `model` real→alias. Returns the
 * input unchanged on parse failure.
 */
export function swapResponseModelJson(bodyText: string, swap: ModelSwap): string {
  try {
    const obj = JSON.parse(bodyText);
    rewriteModelRealToAlias(obj, swap);
    return JSON.stringify(obj);
  } catch {
    return bodyText;
  }
}

/** Rewrite a single SSE line's `model` real→alias (data lines only). */
function rewriteSseLine(line: string, swap: ModelSwap): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice("data:".length).trimStart();
  // Fast skip: the [DONE] sentinel and any chunk that doesn't mention the real
  // id (the vast majority — content deltas) need no parse.
  if (payload === "[DONE]" || !payload.includes(swap.real)) return line;
  try {
    const obj = JSON.parse(payload);
    rewriteModelRealToAlias(obj, swap);
    return `data: ${JSON.stringify(obj)}`;
  } catch {
    return line;
  }
}

/**
 * Streaming (SSE) response transform: rewrite `model` real→alias in each
 * `data:` JSON frame. Line-buffered so a frame split across chunk boundaries is
 * still rewritten correctly (and multi-byte UTF-8 split across chunks is handled
 * by the streaming TextDecoder).
 */
export function createSseModelSwapStream(swap: ModelSwap): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const newlineEnd = buffer.lastIndexOf("\n");
      if (newlineEnd === -1) return; // no complete line yet — keep buffering
      const ready = buffer.slice(0, newlineEnd + 1);
      buffer = buffer.slice(newlineEnd + 1);
      const rewritten = ready
        .split("\n")
        .map((line, i, arr) =>
          // Preserve the trailing "" produced by the final "\n" — don't rewrite it.
          i === arr.length - 1 ? line : rewriteSseLine(line, swap),
        )
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer, swap)));
    },
  });
}
