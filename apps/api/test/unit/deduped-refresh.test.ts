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
 * exercised is exactly the in-process halves: the singleflight map and the
 * per-key serialization chain.
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

  it("serializes a forced and a proactive flight for the same key", async () => {
    const gate = deferred();
    let stored = "STALE";
    let storedIsFresh = false;
    let exchanges = 0;
    let inFlight = 0;
    let peak = 0;

    const run = (force: boolean) =>
      dedupedRefresh<string>("cred_serialized", {
        lockKey: "test:cred_serialized",
        lockLabel: "test",
        force,
        // The proactive verdict: hand back the stored row when a peer (here,
        // the forced flight) has already written a fresh token to it.
        reReadFreshness: async ({ force: f }) => (!f && storedIsFresh ? `STORED:${stored}` : null),
        doRefresh: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await gate.promise;
          exchanges += 1;
          stored = `ROTATED-${exchanges}`;
          storedIsFresh = true;
          inFlight -= 1;
          return stored;
        },
      });

    // The forced flight is held inside `doRefresh` while the proactive one is
    // created: unserialized, the proactive re-read would run against the row
    // as it stands BEFORE the rotation and exchange a second time.
    const forced = run(true);
    const proactive = run(false);
    gate.resolve();

    expect(await forced).toBe("ROTATED-1");
    expect(await proactive).toBe("STORED:ROTATED-1");
    expect(peak).toBe(1);
    expect(exchanges).toBe(1);
  });

  it("a rejected flight does not block the next flight on the same key", async () => {
    const run = (force: boolean, fail: boolean) =>
      dedupedRefresh<string>("cred_rejected", {
        lockKey: "test:cred_rejected",
        lockLabel: "test",
        force,
        reReadFreshness: async () => null,
        doRefresh: async () => {
          if (fail) throw new Error("upstream 503");
          return "EXCHANGED";
        },
      });

    const failing = run(true, true);
    const following = run(false, false);

    await expect(failing).rejects.toThrow("upstream 503");
    expect(await following).toBe("EXCHANGED");

    // The chain is released once it settles — a later flight runs immediately
    // rather than waiting on a tail that will never be cleared.
    expect(await run(true, false)).toBe("EXCHANGED");
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

  it("lets a forced caller adopt an in-flight proactive EXCHANGE", async () => {
    const gate = deferred();
    let exchanges = 0;

    // PROACTIVE flight held inside its exchange: the stored token was stale,
    // so this flight IS minting a new one.
    const proactive = dedupedRefresh<string>("cred_adopt", {
      lockKey: "test:cred_adopt",
      lockLabel: "test",
      force: false,
      reReadFreshness: async () => null,
      doRefresh: async () => {
        await gate.promise;
        exchanges += 1;
        return "EXCHANGED";
      },
    });

    // FORCED caller arriving while that exchange is in flight. Its token was
    // minted upstream, so it cannot be the one that just 401'd this caller —
    // adopting it beats paying another lock wait + exchange behind it.
    const forced = dedupedRefresh<string>("cred_adopt", {
      lockKey: "test:cred_adopt",
      lockLabel: "test",
      force: true,
      reReadFreshness: async () => null,
      doRefresh: async () => {
        exchanges += 1;
        return "SECOND-EXCHANGE";
      },
    });

    gate.resolve();

    expect(await proactive).toBe("EXCHANGED");
    expect(await forced).toBe("EXCHANGED");
    // The whole point: no second hop. Queueing behind the proactive flight
    // would have cost a second lock wait + a second upstream exchange.
    expect(exchanges).toBe(1);
  });

  it("makes a forced caller run its own refresh when the proactive flight fails", async () => {
    const gate = deferred();
    let exchanges = 0;

    const proactive = dedupedRefresh<string>("cred_adopt_fail", {
      lockKey: "test:cred_adopt_fail",
      lockLabel: "test",
      force: false,
      reReadFreshness: async () => null,
      doRefresh: async () => {
        await gate.promise;
        throw new Error("upstream 503");
      },
    });

    const forced = dedupedRefresh<string>("cred_adopt_fail", {
      lockKey: "test:cred_adopt_fail",
      lockLabel: "test",
      force: true,
      reReadFreshness: async () => null,
      doRefresh: async () => {
        exchanges += 1;
        return "EXCHANGED";
      },
    });

    gate.resolve();

    await expect(proactive).rejects.toThrow("upstream 503");
    // A failure is not a token: the forced caller must not inherit it.
    expect(await forced).toBe("EXCHANGED");
    expect(exchanges).toBe(1);
  });

  it("collapses forced callers re-entering after a proactive short-circuit", async () => {
    const gate = deferred();
    let exchanges = 0;

    const proactive = dedupedRefresh<string>("cred_reentry", {
      lockKey: "test:cred_reentry",
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

    const forced = () =>
      dedupedRefresh<string>("cred_reentry", {
        lockKey: "test:cred_reentry",
        lockLabel: "test",
        force: true,
        reReadFreshness: async ({ force }) => (force ? null : "STORED"),
        doRefresh: async () => {
          exchanges += 1;
          return "EXCHANGED";
        },
      });

    const all = [forced(), forced(), forced()];
    gate.resolve();

    expect(await proactive).toBe("STORED");
    expect(await Promise.all(all)).toEqual(["EXCHANGED", "EXCHANGED", "EXCHANGED"]);
    // Re-entry after a non-adoptable outcome must not storm the upstream: the
    // first re-entrant publishes the forced flight, the others collapse in.
    expect(exchanges).toBe(1);
  });
});
