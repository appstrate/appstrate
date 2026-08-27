// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { trackTurn, drainTurns } from "../src/inflight.ts";

/**
 * Graceful shutdown awaits in-flight turns so a deploy/restart does not drop a
 * reply that was mid-generation — bounded by a timeout.
 */
describe("inflight turn registry", () => {
  it("awaits tracked turns and clears them on settle", async () => {
    let done!: () => void;
    const turn = new Promise<void>((r) => (done = r));
    trackTurn(turn);

    // `drainTurns` returns what was pending when the drain started — the only
    // reader of the registry's size, so it is also how the registry is observed.
    const drain = drainTurns(1000);
    done();
    expect(await drain).toBe(1);
    // Settled turns deregister themselves: a second drain finds nothing.
    expect(await drainTurns(1000)).toBe(0);
  });

  it("returns 0 when nothing is in flight", async () => {
    expect(await drainTurns(100)).toBe(0);
  });

  it("is bounded by the timeout when a turn never settles", async () => {
    trackTurn(new Promise<void>(() => {})); // never resolves
    const start = Date.now();
    await drainTurns(50);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
