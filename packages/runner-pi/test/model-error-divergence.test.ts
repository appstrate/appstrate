// SPDX-License-Identifier: Apache-2.0

/**
 * DRIFT guard over the two classifiers that judge one model failure.
 *
 * The agent SDK's `isRetryableAssistantError` decides whether its own in-turn
 * retry loop tries again. Appstrate's `classifyModelError` decides what the
 * user is told and whether a retry is offered. The two answer different
 * questions — by the time a human reads the error the SDK's loop has already
 * finished, and a user retry starts a NEW turn — which is why the vendor
 * verdict is NOT a runtime input to the platform's classifier, and why the two
 * are NOT required to agree. The last corpus entry below is a standing example
 * of a disagreement that is correct on both sides.
 *
 * What this file pins, per corpus entry, is each rule set's answer read side by
 * side: the vendor's retry verdict and Appstrate's category. Neither is
 * structurally anchored to the other — two independent pattern lists, in two
 * repos, moving on two release cadences — so without this test a
 * `@earendil-works/pi-ai` bump could move a pattern from one list to the other
 * and no test anywhere would fail. This makes the vendor's move loud at the
 * moment it lands, so the disagreements we accept stay deliberate instead of
 * going silent. It does NOT prove the two agree.
 *
 * The corpus is real provider failure text — plus the one string the platform
 * manufactures itself — not synthetic strings, because both classifiers are
 * substring matchers and only real wording exercises the overlaps that actually
 * bite.
 *
 * IF THIS TEST FAILS, nothing here is wrong — the VENDOR moved. Read the
 * failure message, then reconcile deliberately: either Appstrate's rules in
 * `packages/core/src/model-error.ts` follow the vendor, or the corpus entry
 * records a disagreement we accept and says why.
 */

import { describe, expect, it } from "bun:test";
import { classifyModelError, type ModelErrorCategory } from "@appstrate/core/model-error";
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
  {
    // Not provider text: the sidecar manufactures this for EVERY failure on an
    // aliased model (`syntheticAliasErrorMessage`, `packages/core/src/model-swap.ts`)
    // so no provider name leaks to the agent — which means it reaches both
    // classifiers exactly like real provider text, and belongs in the corpus.
    name: 'platform-manufactured alias error, no status ("Upstream model error")',
    message: 'Upstream model error (model "my-alias")',
    category: "upstream_unavailable",
    // The two verdicts differ HERE, and both are right: the SDK finds no
    // retryable pattern in this deliberately neutral prose and stops trying
    // within the turn, while Appstrate reads "upstream" and offers the user a
    // fresh attempt — a NEW turn, not the one the SDK gave up on. Adding a
    // status hint (`, status 503`) flips the vendor to true; the platform's
    // category is unchanged either way.
    vendorRetryable: false,
  },
];

describe("model-error classification stays pinned against the agent SDK", () => {
  it("has a corpus (positive control — an empty one passes vacuously)", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of CORPUS) {
    it(`pins both verdicts for: ${entry.name}`, () => {
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
    });
  }
});
