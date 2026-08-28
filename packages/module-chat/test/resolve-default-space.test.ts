// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: a transient /api/spaces failure must NOT be cached.
 * A single blip used to poison the per-org cache with `null`, silently
 * stripping space-scoped MCP tools for that org until eviction.
 */

import { describe, expect, it } from "bun:test";
import { resolveDefaultSpaceId } from "../src/llm.ts";

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

describe("resolveDefaultSpaceId", () => {
  it("does not cache a transient failure — a later call recovers", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn } = seqFetch([
      () => new Response("boom", { status: 500 }),
      () => Response.json({ data: [{ id: "spc_1", isDefault: true }] }),
    ]);

    // First call hits the 500 → undefined, and must NOT poison the cache.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBeUndefined();
    // Second call hits the 200 → resolves. If the failure had been cached this
    // would still return undefined.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_1");
  });

  it("does not cache an empty 200 — a later call recovers", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn } = seqFetch([
      () => Response.json({ data: [] }),
      () => Response.json({ data: [{ id: "spc_3", isDefault: true }] }),
    ]);

    // Empty 200 → undefined, and must NOT poison the cache.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBeUndefined();
    // Second call sees the now-present space.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_3");
  });

  /**
   * `/api/spaces` answers with the list ENVELOPE and only ever has (apps/api
   * `listResponse`; the OpenAPI schema declares `data` required). The reader
   * used to accept a bare array too — a second accepted shape for a producer
   * that cannot emit it. A bare array is now off-contract: no id, and not
   * cached, so the next turn re-reads instead of running on a guess.
   */
  it("refuses a bare array — the envelope is the only shape", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn } = seqFetch([
      () => Response.json([{ id: "spc_bare", isDefault: true }]),
      () => Response.json({ data: [{ id: "spc_4", isDefault: true }] }),
    ]);

    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBeUndefined();
    // …and the off-contract answer was not cached either.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_4");
  });

  it("caches a resolved id (no second fetch)", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn, calls } = seqFetch([
      () => Response.json({ data: [{ id: "spc_2", isDefault: true }] }),
    ]);

    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_2");
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_2");
    expect(calls()).toBe(1);
  });
});
