// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: a transient /api/applications failure must NOT be cached.
 * A single blip used to poison the per-org cache with `null`, silently
 * stripping app-scoped MCP tools for that org until eviction.
 */

import { describe, expect, it } from "bun:test";
import { resolveDefaultApplicationId } from "../src/llm.ts";

const ORIGIN = "http://127.0.0.1:3000";

/** Sequenced fake fetch — each call returns the next scripted Response. */
function seqFetch(responses: Array<() => Response>): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async () => responses[Math.min(n, responses.length - 1)]()) as typeof fetch;
  return {
    fn: (async (...args: Parameters<typeof fetch>) => {
      const r = await fn(...args);
      n++;
      return r;
    }) as typeof fetch,
    calls: () => n,
  };
}

describe("resolveDefaultApplicationId", () => {
  it("does not cache a transient failure — a later call recovers", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn } = seqFetch([
      () => new Response("boom", { status: 500 }),
      () => Response.json({ data: [{ id: "app_1", isDefault: true }] }),
    ]);

    // First call hits the 500 → undefined, and must NOT poison the cache.
    expect(await resolveDefaultApplicationId(ORIGIN, {}, orgId, fn)).toBeUndefined();
    // Second call hits the 200 → resolves. If the failure had been cached this
    // would still return undefined.
    expect(await resolveDefaultApplicationId(ORIGIN, {}, orgId, fn)).toBe("app_1");
  });

  it("caches a resolved id (no second fetch)", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn, calls } = seqFetch([
      () => Response.json({ data: [{ id: "app_2", isDefault: true }] }),
    ]);

    expect(await resolveDefaultApplicationId(ORIGIN, {}, orgId, fn)).toBe("app_2");
    expect(await resolveDefaultApplicationId(ORIGIN, {}, orgId, fn)).toBe("app_2");
    expect(calls()).toBe(1);
  });
});
