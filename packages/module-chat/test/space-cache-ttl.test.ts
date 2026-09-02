// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org default-space cache expires.
 *
 * A resolved id is cached so a turn does not re-read `/api/spaces` every time,
 * but the default space CAN change (an admin re-points it). The cache used to
 * hold an entry forever, so a running process kept routing every turn's MCP
 * calls at the old space until restart. Pinned here with an injected clock:
 * inside the TTL the cached id is served without a fetch; at the TTL the next
 * call fetches again and picks up the new default.
 */

import { describe, expect, it } from "bun:test";
import { resolveDefaultSpaceId, SPACE_CACHE_TTL_MS } from "../src/llm.ts";

const ORIGIN = "http://127.0.0.1:3000";

/** A `/api/spaces` fake answering whatever `current()` names, counting calls. */
function spacesFetch(current: () => string): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async () => {
    n++;
    return Response.json({ data: [{ id: current(), isDefault: true }] });
  }) as typeof fetch;
  return { fn, calls: () => n };
}

describe("resolveDefaultSpaceId cache TTL", () => {
  it("is five minutes", () => {
    expect(SPACE_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it("serves the cached id inside the TTL and re-reads once it has expired", async () => {
    const orgId = `org_${Math.random().toString(36).slice(2)}`;
    let clock = 1_000_000;
    const now = () => clock;
    let current = "spc_old";
    const { fn, calls } = spacesFetch(() => current);

    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn, now)).toBe("spc_old");
    expect(calls()).toBe(1);

    // The platform's default space moves. One tick short of the TTL the cache
    // still answers — no fetch.
    current = "spc_new";
    clock += SPACE_CACHE_TTL_MS - 1;
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn, now)).toBe("spc_old");
    expect(calls()).toBe(1);

    // At the TTL the entry is stale: the fetch runs again and the new default
    // is what the turn gets. Without the expiry this still says `spc_old` with
    // `calls() === 1`.
    clock += 1;
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn, now)).toBe("spc_new");
    expect(calls()).toBe(2);

    // …and the refreshed entry is cached in turn.
    expect(await resolveDefaultSpaceId(ORIGIN, {}, orgId, fn, now)).toBe("spc_new");
    expect(calls()).toBe(2);
  });
});
