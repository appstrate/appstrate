// SPDX-License-Identifier: Apache-2.0

/**
 * THE classifier for a failed model call — one rule set, every surface.
 *
 * The chat surface and the run surface both have to say what a provider
 * failure means. They used to answer with two different bodies of code (a
 * private cascade in the chat module; nothing at all on the run side, which
 * stamped raw text under a single `adapter_error`). These are those rules,
 * moved out so there is one.
 *
 * The agent SDK also classifies failed turns — `isRetryableAssistantError`,
 * two substring lists in `@earendil-works/pi-ai` — but it is NOT an input
 * here, and deliberately so. It answers a different question: "will the SDK's
 * own in-turn retry loop try again?", which is settled and over by the time
 * anything reads this classification. What this module's `retryable` means is
 * "if a human presses retry, might a NEW turn succeed?" — a 503 the SDK gave
 * up on after one attempt is often worth a manual retry a minute later.
 *
 * The two verdicts must still not drift into contradiction, so they are pinned
 * by a test rather than by a runtime handoff:
 * `packages/runner-pi/test/model-error-divergence.test.ts` runs both over a
 * corpus of real provider failure text and fails if a vendor bump moves a
 * pattern out from under these rules. Core cannot hold that test itself —
 * `@appstrate/core` may not import the agent SDK (`no-restricted-imports`, see
 * `docs/architecture/SUPPLY_CHAIN.md`), which is also why this module has no
 * vendor input to reconcile.
 */

/**
 * Stable, provider-neutral class for a failed model call.
 *
 * These five are the whole vocabulary and adding a sixth is a contract change:
 * the values are PERSISTED (chat history carries them in
 * `AppstrateTurnMetadata.errorCategory`) and a reader that meets an unknown
 * one has no sentence for it. In particular there is no separate class for an
 * account the provider refuses to serve — `credential_unavailable` already
 * covers "the provider account is dead", whatever made it dead, and its
 * user-facing sentence already says so.
 */
export type ModelErrorCategory =
  | "credential_unavailable"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_request"
  | "unknown";

/**
 * "Can a fresh attempt succeed without changing the request?", answered from
 * the category alone.
 *
 * The category is the ONLY input on purpose. Every path that produces a
 * `retryable` — classifying a live failure, rebuilding one from a transient
 * stream marker, reading one back off a persisted turn — has the category and
 * nothing else in common, so deriving the flag from anything richer would let
 * those paths disagree about the same failed turn. Exported for exactly those
 * rebuild paths, and because its keys are the category set — the one place
 * membership can be tested at runtime.
 */
export const MODEL_ERROR_RETRYABLE_BY_CATEGORY: Record<ModelErrorCategory, boolean> = {
  credential_unavailable: false,
  rate_limited: true,
  upstream_unavailable: true,
  invalid_request: false,
  unknown: true,
};

export interface ModelErrorInput {
  /**
   * Raw provider text. Never leaves the server on the chat surface — only the
   * classification derived from it does.
   */
  message: string;
  /**
   * HTTP status, when the caller unwrapped one from the error envelope. Absent
   * callers lose nothing: a `[45]xx` in {@link message} is read as a fallback.
   */
  status?: number;
}

export interface ModelErrorClassification {
  category: ModelErrorCategory;
  retryable: boolean;
  /** Public platform request id, when the upstream envelope exposed one. */
  requestId?: string;
}

/** Status the message text admits to, when the caller did not supply one. */
function statusFromMessage(message: string): number | undefined {
  const matched = /\b([45]\d\d)\b/.exec(message);
  return matched ? Number(matched[1]) : undefined;
}

/**
 * Classify one failed model call.
 *
 * The cascade is ordered by how much the caller can DO about the failure, not
 * by status: an explicit 400 must beat the generic "upstream model error"
 * wrapper the platform puts around proxied failures, or every proxied
 * bad-request would read as a transient outage.
 */
export function classifyModelError(input: ModelErrorInput): ModelErrorClassification {
  const message = input.message.trim();
  const normalized = message.toLowerCase();
  const status = input.status ?? statusFromMessage(message);
  const requestId = /\b(req_[A-Za-z0-9_-]+)\b/.exec(message)?.[1];

  let category: ModelErrorCategory;
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    // Provider wording for an account the provider will no longer serve. It
    // lands on `credential_unavailable` with the auth failures on purpose:
    // both mean "this connection is dead until the operator acts on it", and
    // one class means one sentence to write and one branch to maintain.
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
    category,
    retryable: MODEL_ERROR_RETRYABLE_BY_CATEGORY[category],
    ...(requestId ? { requestId } : {}),
  };
}
