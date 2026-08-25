// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral chat-turn error contract for the chat's inference engine.
 * Raw provider messages stay server-side; only this stable classification may
 * cross the stream/persistence boundary.
 */

import { classifyModelError, MODEL_ERROR_RETRYABLE_BY_CATEGORY } from "@appstrate/core/model-error";
import type { ChatTurnErrorCategory } from "@appstrate/core/chat-turn-metadata";

export interface ClientTurnError {
  category: ChatTurnErrorCategory;
  retryable: boolean;
  requestId?: string;
}

const ERROR_MARKER_PREFIX = "appstrate:chat-turn-error:";

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/**
 * Status the error ENVELOPE carries, if any. Only the object shapes live here;
 * digging a status out of the message text is a classification rule and
 * belongs with the others in `@appstrate/core/model-error`.
 */
function statusFromError(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const value = error as { status?: unknown; statusCode?: unknown };
    const status = value.statusCode ?? value.status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  return undefined;
}

export function clientTurnErrorForCategory(category: ChatTurnErrorCategory): ClientTurnError {
  return { category, retryable: MODEL_ERROR_RETRYABLE_BY_CATEGORY[category] };
}

/**
 * Classify a thrown/streamed turn failure for the CLIENT.
 *
 * The rules are not here — they are `classifyModelError`'s, shared with the run
 * surface so one provider string cannot get two verdicts. What is left is the
 * chat-specific part: unwrapping the error object, and keeping the raw text
 * server-side (only the category and the retry flag cross the boundary).
 *
 * It must stay verdict-identical to {@link clientTurnErrorFromMarker}: the UI
 * reads a failed turn through whichever of the two arrived first (persisted
 * metadata, or the transient stream marker), and only the category survives
 * the marker. Anything this path knew that the category does not would make
 * one failed turn offer a retry on one render and refuse it on the next.
 */
export function classifyClientTurnError(error: unknown): ClientTurnError {
  const message = messageFromError(error).trim();
  const status = statusFromError(error);
  return classifyModelError({
    message,
    ...(status !== undefined ? { status } : {}),
  });
}

/** Safe string carried by transient AI-SDK error chunks. */
export function clientTurnErrorMarker(error: ClientTurnError): string {
  return `${ERROR_MARKER_PREFIX}${error.category}`;
}

/** Recover a safe category from a transient stream marker. */
export function clientTurnErrorFromMarker(value: unknown): ClientTurnError | undefined {
  if (typeof value !== "string" || !value.startsWith(ERROR_MARKER_PREFIX)) return undefined;
  const category = value.slice(ERROR_MARKER_PREFIX.length) as ChatTurnErrorCategory;
  return Object.prototype.hasOwnProperty.call(MODEL_ERROR_RETRYABLE_BY_CATEGORY, category)
    ? clientTurnErrorForCategory(category)
    : undefined;
}

/**
 * The refusal code a PRE-STREAM failure carries, if it is one.
 *
 * A turn refused by the admission gate or by a dead subscription credential
 * never enters the stream, so no `appstrate:chat-turn-error:` marker is ever
 * emitted. Instead the AI SDK puts the raw HTTP body in an Error's message and
 * throws it — `ai/src/ui/http-chat-transport.ts`: `throw new Error(await
 * response.text())`, on both `sendMessages` and `reconnectToStream`, so the
 * resumed path lands here too. That body is the `application/problem+json` our
 * refusals answer with (`chat-stream.ts`), so parsing the message back into a
 * problem document recovers what the transport discarded. Its `code` is the
 * stable machine-readable half of the contract; its `detail` is English prose
 * for API consumers (as everywhere else in this API) and must NOT be shown in
 * a localized UI. Return the code so the caller can pick its own sentence.
 *
 * Only a REFUSAL carries a code worth displaying: 401/402/403 mean "you must
 * act". Any other status (a module failing closed with a 500) describes an
 * internal fault the user can do nothing about.
 */
export function refusalCode(value: unknown): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(messageFromError(value));
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const { status, code } = doc as { status?: unknown; code?: unknown };
  if (status !== 401 && status !== 402 && status !== 403) return undefined;
  return typeof code === "string" && code ? code : undefined;
}
