// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `isAffordable` — the balance rule, isolated from the account read.
 *
 * These are the boundary cases the `>=` → `>` change turns on. They live here
 * rather than in `test/integration/` because the comparison is pure: only the
 * `no_account` and `status` branches of `checkQuota` genuinely need a database.
 */
import { describe, expect, it } from "bun:test";
import { isAffordable } from "../../src/billing/quota-check.ts";
import type { UsageQuote } from "../../src/billing/usage-quote.ts";

/** Build a quote worth `total` credits; only `totalCredits` is read. */
function quoteOf(total: number): UsageQuote {
  return { modelCredits: total, computeCredits: 0, totalCredits: total };
}

describe("isAffordable", () => {
  it("admits a quote exactly equal to the remaining balance", () => {
    // remaining = 5000 - 4800 = 200. A quote of exactly 200 FITS — it is not an
    // overshoot. The previous `used + estimate >= quota` rule rejected it.
    expect(isAffordable(quoteOf(200), { creditsUsed: 4800, creditQuota: 5000 })).toBe(true);
  });

  it("rejects a quote one credit above the remaining balance", () => {
    expect(isAffordable(quoteOf(201), { creditsUsed: 4800, creditQuota: 5000 })).toBe(false);
  });

  it("admits a quote one credit below the remaining balance", () => {
    expect(isAffordable(quoteOf(199), { creditsUsed: 4800, creditQuota: 5000 })).toBe(true);
  });

  it("admits a zero quote on an empty account (quota 0, used 0)", () => {
    // The exact regression the `>=` → `>` change fixes: `0 + 0 >= 0` rejected a
    // genuinely free operation on an org with no credits at all.
    expect(isAffordable(quoteOf(0), { creditsUsed: 0, creditQuota: 0 })).toBe(true);
  });

  it("rejects a positive quote on an empty account (quota 0, used 0)", () => {
    expect(isAffordable(quoteOf(1), { creditsUsed: 0, creditQuota: 0 })).toBe(false);
  });

  it("admits a zero quote on a fully consumed quota", () => {
    expect(isAffordable(quoteOf(0), { creditsUsed: 5000, creditQuota: 5000 })).toBe(true);
  });

  it("clamps remaining to 0 when a settled overshoot pushed used past quota", () => {
    // used > quota is reachable: the soft cap admits concurrently and the sweep
    // settles the real cost afterwards. `remaining` must clamp, never go
    // negative — a negative allowance would reject even a zero quote.
    const overshot = { creditsUsed: 7000, creditQuota: 5000 };
    expect(isAffordable(quoteOf(0), overshot)).toBe(true);
    expect(isAffordable(quoteOf(1), overshot)).toBe(false);
  });

  it("admits any quote up to a full untouched quota, and nothing beyond it", () => {
    const fresh = { creditsUsed: 0, creditQuota: 5000 };
    expect(isAffordable(quoteOf(5000), fresh)).toBe(true);
    expect(isAffordable(quoteOf(5001), fresh)).toBe(false);
  });
});
