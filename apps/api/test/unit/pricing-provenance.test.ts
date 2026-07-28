// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolvePricingStatus()` — specifically its per-process warn
 * de-dup, which is keyed on `(orgId, model, status)`.
 *
 * `warnedKeys` is module-level and deliberately never reset, so every case here
 * uses org ids unique to itself rather than trying to clear it. `logger.warn` is
 * observed with `spyOn` (no `mock.module()`, per the repo mocking policy).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../src/lib/logger.ts";
import { resolvePricingStatus } from "../../src/services/pricing-provenance.ts";

const USAGE = { input_tokens: 100, output_tokens: 10 };

describe("resolvePricingStatus — warn de-dup key", () => {
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;

  beforeEach(() => {
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once for a repeated (orgId, model, status), and never for `priced`", () => {
    const orgId = "org_dedup_same";

    expect(resolvePricingStatus({ orgId, model: "gpt-4o", usage: USAGE, cost: null })).toBe(
      "unpriced",
    );
    resolvePricingStatus({ orgId, model: "gpt-4o", usage: USAGE, cost: null });
    resolvePricingStatus({ orgId, model: "gpt-4o", usage: USAGE, cost: null });

    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A priced row is not a gap — it never reaches the de-dup at all.
    expect(
      resolvePricingStatus({
        orgId,
        model: "gpt-4o",
        usage: USAGE,
        cost: { input: 1, output: 2 },
      }),
    ).toBe("priced");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns again for a different org, a different model, and a different status", () => {
    const cacheUsage = { ...USAGE, cache_read_input_tokens: 50 };
    // No `cacheRead` rate while cached input tokens were reported → `partial`.
    const partialCost = { input: 1, output: 2 };

    resolvePricingStatus({ orgId: "org_dedup_a", model: "gpt-4o", usage: USAGE, cost: null });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Different org, same model + status.
    resolvePricingStatus({ orgId: "org_dedup_b", model: "gpt-4o", usage: USAGE, cost: null });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Same org, different model.
    resolvePricingStatus({ orgId: "org_dedup_a", model: "claude-4", usage: USAGE, cost: null });
    expect(warnSpy).toHaveBeenCalledTimes(3);

    // Same org + model, different status.
    expect(
      resolvePricingStatus({
        orgId: "org_dedup_a",
        model: "gpt-4o",
        usage: cacheUsage,
        cost: partialCost,
      }),
    ).toBe("partial");
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it("does not collide when a component contains the separator the key encodes", () => {
    // Naive concatenation would fold these two into one key.
    resolvePricingStatus({ orgId: "org_sep", model: '","x', usage: USAGE, cost: null });
    resolvePricingStatus({ orgId: 'org_sep","', model: "x", usage: USAGE, cost: null });

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("re-arms a key once the cap clears the set", () => {
    const seed = { orgId: "org_cap_seed", model: "gpt-4o", usage: USAGE, cost: null };
    resolvePricingStatus(seed);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // WARNED_KEYS_CAP distinct keys is enough to drive the size past the cap and
    // clear the whole set (the damper is a clear, not an LRU eviction).
    for (let i = 0; i < 500; i++) {
      resolvePricingStatus({
        orgId: `org_cap_fill_${i}`,
        model: "gpt-4o",
        usage: USAGE,
        cost: null,
      });
    }

    resolvePricingStatus(seed);
    expect(warnSpy).toHaveBeenCalledTimes(502);
  });
});
