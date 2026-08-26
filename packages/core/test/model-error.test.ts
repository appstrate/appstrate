// SPDX-License-Identifier: Apache-2.0

/**
 * The classification rules, tested where they now live.
 *
 * Every case came verbatim from the chat module's own
 * `chat-error-classification.test.ts` — moving the rules must not move a single
 * verdict, so both fields here are what was asserted before the move.
 *
 * The agent SDK's own retry verdict is deliberately absent: it is not an input
 * to these rules (see the module header), and core may not import the SDK
 * anyway. The test that pins the two against each other over real provider text
 * is `packages/runner-pi/test/model-error-divergence.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { classifyModelError, MODEL_ERROR_RETRYABLE_BY_CATEGORY } from "../src/model-error.ts";
import { syntheticAliasClassifierMessage } from "../src/model-swap.ts";

describe("classifyModelError", () => {
  it("turns an aliased 402 into actionable provider-neutral metadata", () => {
    expect(
      classifyModelError({
        message: "Upstream model error (status 402). Request ID req_public_123",
      }),
    ).toEqual({
      category: "credential_unavailable",
      retryable: false,
      requestId: "req_public_123",
    });
  });

  it("classifies throttling as retryable", () => {
    expect(classifyModelError({ message: "429 rate limit from hidden-backend" })).toEqual({
      category: "rate_limited",
      retryable: true,
    });
  });

  it("lets an explicit 400 win over the generic upstream wrapper", () => {
    expect(classifyModelError({ message: "Upstream model error (status 400)" })).toEqual({
      category: "invalid_request",
      retryable: false,
    });
  });

  it("classifies 5xx and unclassifiable failures", () => {
    expect(classifyModelError({ message: "provider secret dump status 503" })).toEqual({
      category: "upstream_unavailable",
      retryable: true,
    });
    expect(classifyModelError({ message: "private opaque backend details" })).toEqual({
      category: "unknown",
      retryable: true,
    });
  });

  it("prefers an envelope status over the one the text admits to", () => {
    // The message names a 503; the envelope says 429. A caller that unwrapped a
    // real status did better than a regex over prose, so it wins.
    expect(
      classifyModelError({ message: "gateway said 503 somewhere", status: 429 }).category,
    ).toBe("rate_limited");
  });

  it("derives `retryable` from the category and nothing else", () => {
    // The table is the ONLY source of the flag, and the only runtime
    // description of the category set. A drift here silently changes what a
    // recovered category (stream marker, persisted turn) rebuilds into — and
    // any input that could move `retryable` independently of the category would
    // let those rebuild paths disagree with this one.
    expect(MODEL_ERROR_RETRYABLE_BY_CATEGORY).toEqual({
      credential_unavailable: false,
      rate_limited: true,
      upstream_unavailable: true,
      invalid_request: false,
      unknown: true,
    });
  });

  it("agrees with the category table on every category", () => {
    const byCategory = {
      credential_unavailable: "401 unauthorized",
      rate_limited: "429 rate limit",
      upstream_unavailable: "503 upstream",
      invalid_request: "400 invalid request",
      unknown: "opaque",
    } as const;
    for (const [category, message] of Object.entries(byCategory)) {
      const classified = classifyModelError({ message });
      expect(classified.category).toBe(category as keyof typeof byCategory);
      expect(classified.retryable).toBe(
        MODEL_ERROR_RETRYABLE_BY_CATEGORY[category as keyof typeof byCategory],
      );
    }
  });
});

/**
 * ONE failed model call, TWO classifiers, and they must reach the same verdict.
 *
 * On an aliased model the vendor's prose is gone: the alias boundary replaces
 * the whole body with `syntheticAliasClassifierMessage` — the fixed words
 * "Upstream model error" plus a forwarded status — and that sentence is read by
 * two independent rule sets. pi-ai's `isRetryableAssistantError` spends the
 * container's in-turn retry budget on it; this module's `classifyModelError`
 * drives `run_logs.data.error_retryable` on the run trail
 * (`packages/runner-pi/src/pi-runner.ts`) and the chat surface's retry
 * affordance through `classifyClientTurnError`. Both are substring matchers
 * over the same fourteen sentences.
 *
 * Elsewhere the two are allowed to differ — they answer different questions
 * (see this package's `src/model-error.ts` header), and
 * `packages/runner-pi/test/model-error-divergence.test.ts` records the
 * divergences we accept over real provider text. HERE they may not: nothing is
 * left in the sentence but the status, so a disagreement is not two rule sets
 * weighing different evidence, it is one of them misreading the only evidence
 * there is. `classifyModelError` used to read the word "upstream" as a
 * transient 5xx and hand back `retryable: true` for every forwardable status it
 * did not name — `404` `405` `408` `409` `413` `415` — which is the 413 case
 * (oversized prompt, retried to the max on a request that can never succeed)
 * fixed on the pi-ai path and left live on this one.
 */
describe("classifyModelError agrees with pi-ai on every forwardable alias status", () => {
  /**
   * The forwardable set, DERIVED from the boundary rather than copied into
   * this file. `syntheticAliasClassifierMessage` interpolates `(status N)`
   * only for a status in `FORWARDABLE_UPSTREAM_STATUSES` — module-private, and
   * deliberately not part of the published surface — so the statuses that come
   * back carrying a hint ARE that set. Sweeping for them means this test
   * follows the set if it ever moves instead of silently testing a stale copy.
   */
  const FORWARDABLE = Array.from({ length: 500 }, (_, i) => 100 + i).filter((status) =>
    syntheticAliasClassifierMessage(status).includes(`(status ${status})`),
  );

  /**
   * pi-ai's verdict for each of those fourteen sentences, PINNED.
   *
   * Core may not import the agent SDK — `no-restricted-imports` in
   * `eslint.config.mjs` bans `@earendil-works/pi-*` from `packages/core/src`
   * AND `packages/core/test` (docs/architecture/SUPPLY_CHAIN.md: the ban is
   * absolute here because core has no `pi-sdk.ts` barrel to route through), so
   * the vendor predicate cannot be called from this file. This table is
   * asserted against the REAL `isRetryableAssistantError` in
   * `packages/runner-pi/test/model-error-divergence.test.ts`, which may import
   * it; that test fails loudly if a vendor bump moves one of these.
   *
   * The values are not guesses: `RETRYABLE_PROVIDER_ERROR_PATTERN` alternates
   * over the status literals `429` `500` `502` `503` `504` `524` and a list of
   * words ("overloaded", "rate limit", "fetch failed", …) that this boundary
   * has already scrubbed out of the sentence. No other forwardable status
   * appears in it, so every other one is terminal.
   */
  const VENDOR_RETRYABLE = new Set([429, 500, 502, 503, 504]);

  it("derives the set the boundary actually forwards (positive control)", () => {
    // Without this an empty or truncated sweep would make every assertion
    // below pass vacuously.
    expect(FORWARDABLE).toEqual([
      400, 401, 403, 404, 405, 408, 409, 413, 415, 429, 500, 502, 503, 504,
    ]);
  });

  it("reaches the vendor's verdict from the message alone (the run trail's path)", () => {
    // `pi-runner.ts` calls `classifyModelError({ message })` with no status:
    // the `(status N)` hint in the text is all it has.
    const actual = FORWARDABLE.map(
      (status) =>
        `${status} ${classifyModelError({ message: syntheticAliasClassifierMessage(status) }).retryable}`,
    );
    expect(actual).toEqual(
      FORWARDABLE.map((status) => `${status} ${VENDOR_RETRYABLE.has(status)}`),
    );
  });

  it("reaches the same verdict when the caller unwrapped the status (the chat path)", () => {
    // `classifyClientTurnError` digs a status out of the error envelope and
    // passes it alongside. Same sentence, same status, same answer — a surface
    // that happens to unwrap more must not offer a retry the other refuses.
    const actual = FORWARDABLE.map(
      (status) =>
        `${status} ${
          classifyModelError({ message: syntheticAliasClassifierMessage(status), status }).retryable
        }`,
    );
    expect(actual).toEqual(
      FORWARDABLE.map((status) => `${status} ${VENDOR_RETRYABLE.has(status)}`),
    );
  });

  it("413 is terminal — an oversized prompt is never a retry offer", () => {
    // The named regression. A 413 says the request as sent cannot fit; a retry
    // re-sends the identical oversized prompt, so offering one spends the
    // retry budget (or the user's click) on a certainty.
    expect(classifyModelError({ message: syntheticAliasClassifierMessage(413) })).toEqual({
      category: "invalid_request",
      retryable: false,
    });
  });

  it("leaves the status-LESS alias sentence exactly where it was", () => {
    // The boundary omits the hint when it has no status to disclose, and then
    // the prose IS the only evidence. This is the one accepted divergence
    // (pinned as a corpus entry in the runner-pi drift test): the SDK stops
    // trying within the turn, the platform still offers a human a fresh one.
    expect(classifyModelError({ message: syntheticAliasClassifierMessage() })).toEqual({
      category: "upstream_unavailable",
      retryable: true,
    });
  });
});
