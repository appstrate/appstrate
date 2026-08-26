// SPDX-License-Identifier: Apache-2.0

/**
 * `dedupedRefresh` singleflight semantics — specifically what a FORCED caller
 * is entitled to when a proactive refresh for the same credential is already
 * in flight.
 *
 * `force` exists because a caller recovering from an upstream 401 has positive
 * evidence the stored token is dead, so the post-lock freshness short-circuit
 * must not hand that token back. That guarantee is only worth anything if the
 * forced caller's own verdict is the one applied: a flight carries its
 * ORIGINATOR's `force` to `reReadFreshness`, so a shared flight silently gives
 * the forced caller the proactive verdict — including its short-circuit — and
 * the 401'd token comes straight back with `{status:"refreshed"}` and no
 * upstream exchange at all.
 *
 * Tier 0 has no Redis, so `withRedisLock` is a pass-through here and what is
 * exercised is exactly the in-process singleflight map.
 */

import { describe, it, expect } from "bun:test";
import { dedupedRefresh } from "../../src/lib/deduped-refresh.ts";

/** Minimal deferred, so a flight can be held open at a known point. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("dedupedRefresh", () => {
  it("does not give a forced caller a proactive flight's freshness short-circuit", async () => {
    const gate = deferred();
    let exchanges = 0;

    // PROACTIVE flight: a peer instance wrote a token while we queued, so its
    // re-read short-circuits and returns the STORED value — no exchange.
    const proactive = dedupedRefresh<string>("cred_share", {
      lockKey: "test:cred_share",
      lockLabel: "test",
      force: false,
      reReadFreshness: async ({ force }) => {
        await gate.promise;
        return force ? null : "STORED";
      },
      doRefresh: async () => {
        exchanges += 1;
        return "EXCHANGED";
      },
    });

    // FORCED caller arriving while that flight is still inside its re-read.
    // "STORED" is precisely the token that just 401'd it.
    const forced = dedupedRefresh<string>("cred_share", {
      lockKey: "test:cred_share",
      lockLabel: "test",
      force: true,
      reReadFreshness: async ({ force }) => (force ? null : "STORED"),
      doRefresh: async () => {
        exchanges += 1;
        return "EXCHANGED";
      },
    });

    gate.resolve();

    expect(await proactive).toBe("STORED");
    expect(await forced).toBe("EXCHANGED");
    // Exactly one exchange: the forced flight's. The proactive one short-circuits.
    expect(exchanges).toBe(1);
  });

  it("still collapses concurrent forced callers into one exchange", async () => {
    const gate = deferred();
    let exchanges = 0;

    const start = () =>
      dedupedRefresh<string>("cred_storm", {
        lockKey: "test:cred_storm",
        lockLabel: "test",
        force: true,
        reReadFreshness: async () => null,
        doRefresh: async () => {
          await gate.promise;
          exchanges += 1;
          return "EXCHANGED";
        },
      });

    const all = [start(), start(), start()];
    gate.resolve();

    expect(await Promise.all(all)).toEqual(["EXCHANGED", "EXCHANGED", "EXCHANGED"]);
    expect(exchanges).toBe(1);
  });

  it("still collapses concurrent proactive callers into one flight", async () => {
    const gate = deferred();
    let reReads = 0;

    const start = () =>
      dedupedRefresh<string>("cred_proactive", {
        lockKey: "test:cred_proactive",
        lockLabel: "test",
        force: false,
        reReadFreshness: async () => {
          reReads += 1;
          await gate.promise;
          return "STORED";
        },
        doRefresh: async () => "EXCHANGED",
      });

    const all = [start(), start()];
    gate.resolve();

    expect(await Promise.all(all)).toEqual(["STORED", "STORED"]);
    expect(reReads).toBe(1);
  });

  it("releases the flight so a later forced caller runs its own refresh", async () => {
    let exchanges = 0;
    const run = (force: boolean) =>
      dedupedRefresh<string>("cred_sequential", {
        lockKey: "test:cred_sequential",
        lockLabel: "test",
        force,
        reReadFreshness: async ({ force: f }) => (f ? null : "STORED"),
        doRefresh: async () => {
          exchanges += 1;
          return "EXCHANGED";
        },
      });

    expect(await run(false)).toBe("STORED");
    expect(await run(true)).toBe("EXCHANGED");
    expect(exchanges).toBe(1);
  });
});
