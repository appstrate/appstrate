// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral chat-turn error contract shared by both inference engines.
 * Raw provider messages stay server-side; only this stable classification may
 * cross the stream/persistence boundary.
 */

import type { ChatTurnErrorCategory } from "@appstrate/core/chat-turn-metadata";

export interface ClientTurnError {
  category: ChatTurnErrorCategory;
  retryable: boolean;
  requestId?: string;
}

const ERROR_MARKER_PREFIX = "appstrate:chat-turn-error:";

const RETRYABLE_BY_CATEGORY: Record<ChatTurnErrorCategory, boolean> = {
  credential_unavailable: false,
  rate_limited: true,
  upstream_unavailable: true,
  invalid_request: false,
  unknown: true,
};

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function statusFromError(error: unknown, message: string): number | undefined {
  if (error && typeof error === "object") {
    const value = error as { status?: unknown; statusCode?: unknown };
    const status = value.statusCode ?? value.status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  const matched = /\b([45]\d\d)\b/.exec(message);
  return matched ? Number(matched[1]) : undefined;
}

export function clientTurnErrorForCategory(category: ChatTurnErrorCategory): ClientTurnError {
  return { category, retryable: RETRYABLE_BY_CATEGORY[category] };
}

export function classifyClientTurnError(error: unknown): ClientTurnError {
  const message = messageFromError(error).trim();
  const normalized = message.toLowerCase();
  const status = statusFromError(error, message);
  const requestId = /\b(req_[A-Za-z0-9_-]+)\b/.exec(message)?.[1];

  let category: ChatTurnErrorCategory;
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    normalized.includes("insufficient balance") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("billing") ||
    normalized.includes("api key") ||
    normalized.includes("authentication") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("credential")
  ) {
    category = "credential_unavailable";
  } else if (status === 429 || normalized.includes("rate limit")) {
    category = "rate_limited";
  } else if (status === 400 || normalized.includes("invalid request")) {
    category = "invalid_request";
  } else if (
    (status !== undefined && status >= 500) ||
    normalized.includes("upstream model error")
  ) {
    category = "upstream_unavailable";
  } else {
    category = "unknown";
  }

  return {
    ...clientTurnErrorForCategory(category),
    ...(requestId ? { requestId } : {}),
  };
}

/** Safe string carried by transient AI-SDK error chunks. */
export function clientTurnErrorMarker(error: ClientTurnError): string {
  return `${ERROR_MARKER_PREFIX}${error.category}`;
}

/** Recover a safe category from a transient stream marker. */
export function clientTurnErrorFromMarker(value: unknown): ClientTurnError | undefined {
  if (typeof value !== "string" || !value.startsWith(ERROR_MARKER_PREFIX)) return undefined;
  const category = value.slice(ERROR_MARKER_PREFIX.length) as ChatTurnErrorCategory;
  return Object.prototype.hasOwnProperty.call(RETRYABLE_BY_CATEGORY, category)
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
 * document recovers what the transport discarded. Its `code` is the
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
