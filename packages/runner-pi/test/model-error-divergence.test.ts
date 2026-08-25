// SPDX-License-Identifier: Apache-2.0

/**
 * NON-DIVERGENCE guard between the two classifiers that judge one model
 * failure.
 *
 * The agent SDK's `isRetryableAssistantError` decides whether its own in-turn
 * retry loop tries again. Appstrate's `classifyModelError` decides what the
 * user is told and whether a retry is offered. The two answer different
 * questions — by the time a human reads the error the SDK's loop has already
 * finished, and a user retry starts a NEW turn — which is why the vendor
 * verdict is NOT a runtime input to the platform's classifier.
 *
 * But nothing structurally pins them together either: they are two independent
 * pattern lists, in two repos, moving on two release cadences. Without this
 * test a `@earendil-works/pi-ai` bump could move a pattern from one list to the
 * other and no test anywhere would fail — the engine would quietly stop
 * retrying something the UI still advertised as retryable, or keep retrying
 * something the UI had already declared dead. A test is the right pin
 * precisely BECAUSE a runtime handoff is not: it makes the drift loud without
 * letting the vendor's answer to its own question leak into ours.
 *
 * The corpus is real provider failure text, not synthetic strings, because
 * both classifiers are substring matchers and only real wording exercises the
 * overlaps that actually bite.
 *
 * IF THIS TEST FAILS, nothing here is wrong — the VENDOR moved. Read the
 * failure message, then reconcile deliberately: either Appstrate's rules in
 * `packages/core/src/model-error.ts` follow the vendor, or the corpus entry
 * records a disagreement we accept and says why.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyModelError,
  MODEL_ERROR_RETRYABLE_BY_CATEGORY,
  type ModelErrorCategory,
} from "@appstrate/core/model-error";
// Straight from the vendor, not through `src/pi-sdk.ts`. The barrel's header is
// explicit that nothing test-only belongs in it — two re-exports were removed
// from it for exactly that reason — and its `no-restricted-imports` guard never
// covered `packages/*/test/**`. Nothing in production consults this predicate,
// so a barrel member would have been a dead export whose only reader is this
// file.
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/**
 * The vendor's verdict on a bare error string. It takes a whole
 * `AssistantMessage` and reads exactly two fields off it (`stopReason`,
 * `errorMessage`), which is all a corpus entry has.
 */
function vendorRetryable(message: string): boolean {
  return isRetryableAssistantError({
    stopReason: "error",
    errorMessage: message,
  } as AssistantMessage);
}

interface Case {
  /** What a provider actually returns. */
  name: string;
  message: string;
  status?: number;
  category: ModelErrorCategory;
  /** What the SDK's retry loop does with it today. */
  vendorRetryable: boolean;
}

const CORPUS: Case[] = [
  {
    name: "OpenAI 429 with an exhausted account (the case that motivated all this)",
    message:
      "429 You exceeded your current quota, please check your plan and billing details. " +
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota",' +
      '"code":"insufficient_quota"}}',
    // Not `rate_limited`, even though it IS a 429: the wording names an account
    // the provider will not serve, and that is the actionable half.
    category: "credential_unavailable",
    // The SDK's non-retryable list wins over its own "429" retryable pattern.
    vendorRetryable: false,
  },
  {
    name: "Gemini 503 UNAVAILABLE under load",
    message:
      "[503 Service Unavailable] The model is overloaded because of high demand. " +
      "Please try again later. status: UNAVAILABLE",
    category: "upstream_unavailable",
    vendorRetryable: true,
  },
  {
    name: "OpenAI 401 with a bad key",
    message:
      "401 Incorrect API key provided: sk-***. You can find your API key at " +
      "https://platform.openai.com/account/api-keys.",
    category: "credential_unavailable",
    vendorRetryable: false,
  },
  {
    name: "bare transport failure (undici)",
    message: "fetch failed",
    category: "unknown",
    vendorRetryable: true,
  },
  {
    name: "context overflow",
    message:
      "This model's maximum context length is 128000 tokens. However, your messages " +
      "resulted in 131072 tokens. Please reduce the length of the messages.",
    status: 400,
    category: "invalid_request",
    vendorRetryable: false,
  },
];

describe("model-error classification does not diverge from the agent SDK", () => {
  it("has a corpus (positive control — an empty one passes vacuously)", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of CORPUS) {
    it(`agrees on: ${entry.name}`, () => {
      const vendor = vendorRetryable(entry.message);
      expect(
        vendor,
        `The agent SDK's retry verdict for this provider text moved: expected ` +
          `${entry.vendorRetryable}, got ${vendor}. A @earendil-works/pi-ai bump ` +
          `changed NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN or ` +
          `RETRYABLE_PROVIDER_ERROR_PATTERN (dist/utils/retry.js). The engine now ` +
          `retries this failure differently than it did, so Appstrate's rules in ` +
          `packages/core/src/model-error.ts must be re-reconciled against it — ` +
          `do not just update this number.\n  ${entry.message}`,
      ).toBe(entry.vendorRetryable);

      const classified = classifyModelError({
        message: entry.message,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
      });
      expect(classified.category).toBe(entry.category);

      // THE invariant. On real provider text the two classifiers reach the same
      // conclusion about retrying — Appstrate's, read off the category alone,
      // and the SDK's, read off its own pattern lists. They are not wired
      // together, so this agreement is a fact about the two rule sets, not a
      // tautology. A failure means one moved under the other, which is exactly
      // the silent drift this file exists to make loud.
      expect(
        classified.retryable,
        `Appstrate would ${MODEL_ERROR_RETRYABLE_BY_CATEGORY[entry.category] ? "" : "not "}` +
          `retry this (category "${entry.category}") while the agent SDK would ` +
          `${vendor ? "" : "not "}. The two classifiers have drifted apart on real ` +
          `provider text; one of the two pattern lists must be corrected.`,
      ).toBe(MODEL_ERROR_RETRYABLE_BY_CATEGORY[entry.category]);
    });
  }
});
