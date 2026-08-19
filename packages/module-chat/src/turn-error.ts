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
 * The display sentence a PRE-STREAM refusal carries.
 *
 * A turn refused by the admission gate or by a dead subscription credential
 * never enters the stream, so no `appstrate:chat-turn-error:` marker is ever
 * emitted — the AI SDK transport throws with the raw response body as its
 * message. That body is an RFC 9457 problem document whose `detail` is the
 * user-facing copy, exactly as everywhere else in the SPA (see
 * `apps/web/src/api/client.ts`). Return it so the refusal says what happened
 * instead of pointing at the model, which is not the problem.
 *
 * Only a REFUSAL's detail is displayable: 401/402/403 mean "you must act", and
 * their copy is written for the user. Any other status (a module failing closed
 * with a 500) carries internal text and must not reach the screen.
 */
export function refusalDetail(value: unknown): string | undefined {
  const message = messageFromError(value).trim();
  if (!message.startsWith("{")) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const { status, detail } = doc as { status?: unknown; detail?: unknown };
  if (status !== 401 && status !== 402 && status !== 403) return undefined;
  return typeof detail === "string" && detail.trim() ? detail : undefined;
}
