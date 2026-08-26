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
   * callers lose nothing: a `[45]xx` in {@link message} is read as a fallback,
   * and either way the status outranks the prose it travelled with.
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
 * A 4xx: the upstream's own verdict that re-sending the IDENTICAL request can
 * never succeed.
 *
 * The whole class is terminal, not just the handful of codes a model API
 * happens to document. The alias boundary
 * (`syntheticAliasClassifierMessage`, `./model-swap`) forwards fourteen
 * statuses into a sentence whose vendor prose has been replaced by the fixed
 * words "Upstream model error", so for `404` `405` `408` `409` `413` `415`
 * that sentence is the ONLY thing left to classify by — and reading it as
 * prose used to hand every one of them to the transient branch below on the
 * strength of the word "upstream". `413` is the case that makes it concrete:
 * an oversized prompt is unfixable by retrying, and it was being offered a
 * retry on both the run trail (`run_logs.data.error_retryable`) and the chat
 * surface. The status is authoritative over the prose that surrounds it.
 *
 * Statuses this predicate ADDS to the terminal side beyond the forwardable
 * fourteen — `422` (Mistral's request-validation code), `431`, and every other
 * unnamed 4xx — get the same verdict for the same reason, which is also what
 * `projectAliasUpstreamStatus` already decided when it collapses an unknown
 * 4xx to `400`.
 */
function isTerminalRequestStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * Classify one failed model call.
 *
 * The cascade is ordered by how much the caller can DO about the failure, not
 * by status: a dead credential and a throttle are read first, whatever code
 * carried them.
 *
 * Below those two, a KNOWN status wins over the prose around it — a 4xx is
 * terminal and a 5xx is transient — and the generic "upstream model error"
 * wrapper the platform puts around proxied failures only classifies a message
 * that carries no status at all. Without that ordering every proxied 4xx read
 * as a transient outage: see {@link isTerminalRequestStatus}.
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
  } else if (isTerminalRequestStatus(status) || normalized.includes("invalid request")) {
    category = "invalid_request";
  } else if (
    (status !== undefined && status >= 500) ||
    // Reachable only with NO 4xx/5xx status in hand: every 4xx was taken by the
    // branch above and every 5xx by the clause beside this one. That ordering
    // is what keeps this substring from overriding a status — it may still
    // classify the status-LESS "Upstream model error", which is all it was
    // ever meant to do.
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
