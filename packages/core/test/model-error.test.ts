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
