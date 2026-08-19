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
  /**
   * Set only for a pre-stream refusal whose RFC 9457 `code` we display verbatim
   * (see `clientTurnErrorFromProblem`). Never persisted — the stored turn
   * metadata carries `category` alone.
   */
  code?: ChatProblemCode;
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
 * Codes an RFC 9457 problem document from `POST /api/chat` can carry. These
 * refusals happen BEFORE the stream opens, so they never reach the client as an
 * in-stream marker — see `clientTurnErrorFromProblem`.
 */
const CHAT_PROBLEM_CODES = [
  "quota_exceeded",
  "subscription_blocked",
  "needs_reconnection",
] as const;

export type ChatProblemCode = (typeof CHAT_PROBLEM_CODES)[number];

const KNOWN_PROBLEM_CODES: ReadonlySet<string> = new Set(CHAT_PROBLEM_CODES);

function parseProblemDocument(
  message: string,
): { code?: string; status?: number; detail?: string } | undefined {
  if (!message.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const doc = parsed as { code?: unknown; status?: unknown; detail?: unknown };
  return {
    ...(typeof doc.code === "string" ? { code: doc.code } : {}),
    ...(typeof doc.status === "number" ? { status: doc.status } : {}),
    ...(typeof doc.detail === "string" ? { detail: doc.detail } : {}),
  };
}

/**
 * Recover a displayable error from a PRE-STREAM HTTP failure.
 *
 * A turn refused by the admission gate (402 `quota_exceeded`), by a suspended
 * subscription (402 `subscription_blocked`) or by a dead credential (401
 * `needs_reconnection`) never enters the stream, so the AI SDK transport throws
 * with the raw response body as its message and no `appstrate:chat-turn-error:`
 * marker is ever emitted. Parse the problem document back into the same client
 * contract, keeping its `code` when we have a dedicated message for it and
 * falling back to the status-based classification otherwise.
 */
export function clientTurnErrorFromProblem(value: unknown): ClientTurnError | undefined {
  const doc = parseProblemDocument(messageFromError(value).trim());
  if (!doc) return undefined;

  const classified = classifyClientTurnError(
    Object.assign(
      new Error(doc.detail ?? ""),
      doc.status !== undefined ? { status: doc.status } : {},
    ),
  );
  const code = doc.code;
  // A refusal never clears by retrying — the user has to top up, reactivate or
  // reconnect first. Pinned here rather than inherited from the status, which a
  // billing module is free to change.
  if (code !== undefined && KNOWN_PROBLEM_CODES.has(code)) {
    return { ...classified, code: code as ChatProblemCode, retryable: false };
  }
  return classified;
}
