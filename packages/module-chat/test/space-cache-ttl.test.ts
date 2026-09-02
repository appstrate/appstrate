// SPDX-License-Identifier: Apache-2.0

/**
 * The default-space lookup's cache — a `@appstrate/core/cache` with a
 * five-minute TTL. The TTL is what lets an admin re-point the default space
 * without a platform restart; the coalescing is what keeps N concurrent turns
 * of one org from each paying the lookup.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { setCacheClock } from "@appstrate/core/cache";
import { resolveDefaultSpaceId, SPACE_CACHE_TTL_MS } from "../src/llm.ts";

const ORIGIN = "http://127.0.0.1:3000";

function spacesFetch(current: () => string): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async () => {
    n++;
    return Response.json({ data: [{ id: current(), isDefault: true }] });
  }) as typeof fetch;
  return { fn, calls: () => n };
}

afterEach(() => setCacheClock(null));

describe("resolveDefaultSpaceId cache TTL", () => {
  it("is five minutes", () => {
    expect(SPACE_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it("serves the cached id inside the TTL and re-reads once it has expired", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    let clock = 1_000_000;
    setCacheClock(() => clock);
    let current = "spc_old";
    const { fn, calls } = spacesFetch(() => current);

    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_old");
    expect(calls()).toBe(1);

    // The platform's default space moves. One tick short of the TTL the cache
    // still answers — no fetch.
    current = "spc_new";
    clock += SPACE_CACHE_TTL_MS - 1;
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_old");
    expect(calls()).toBe(1);

    // At the TTL the entry is stale: the fetch runs again and the new default
    // is what the turn gets. Without the expiry this still says `spc_old` with
    // `calls() === 1`.
    clock += 1;
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_new");
    expect(calls()).toBe(2);

    // …and the refreshed entry is cached in turn.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn)).toBe("spc_new");
    expect(calls()).toBe(2);
  });

  it("coalesces concurrent lookups of one org into a single fetch", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    const { fn, calls } = spacesFetch(() => "spc_shared");

    const ids = await Promise.all([
      resolveDefaultSpaceId(ORIGIN, {}, orgId, fn),
      resolveDefaultSpaceId(ORIGIN, {}, orgId, fn),
      resolveDefaultSpaceId(ORIGIN, {}, orgId, fn),
    ]);
    expect(ids).toEqual(["spc_shared", "spc_shared", "spc_shared"]);
    // Negative control: the per-org `Map` this replaced fetched three times.
    expect(calls()).toBe(1);
  });
});
