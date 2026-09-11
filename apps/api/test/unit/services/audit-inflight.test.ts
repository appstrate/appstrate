// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the audit in-flight registry (`trackAudit` / `drainAudits`).
 *
 * The MCP router hands its audit inserts to `trackAudit` instead of awaiting
 * them on the response path; graceful shutdown calls `drainAudits` so the
 * trail still survives a recycle. These pin that contract without a DB: the
 * registry only ever sees promises.
 *
 * The registry is process-global and the suite runs in one process, so every
 * count below is a DELTA against what was pending when the test started.
 */

import { describe, it, expect } from "bun:test";
import { trackAudit, drainAudits, pendingAuditCount } from "../../../src/services/audit.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("audit in-flight registry", () => {
  it("drainAudits waits for a pending tracked insert, then reports it drained", async () => {
    const before = pendingAuditCount();
    const insert = deferred();
    trackAudit(insert.promise);
    expect(pendingAuditCount()).toBe(before + 1);

    let settled = false;
    const drain = drainAudits(1_000).then((result) => {
      settled = true;
      return result;
    });
    await Bun.sleep(20);
    // Still pending: the drain is genuinely awaiting the insert.
    expect(settled).toBe(false);

    insert.resolve();
    const result = await drain;
    expect(result.drained).toBe(true);
    expect(result.pending).toBe(before + 1);
    expect(pendingAuditCount()).toBe(before);
  });

  it("drainAudits times out without dropping the still-pending entry", async () => {
    const before = pendingAuditCount();
    const insert = deferred();
    trackAudit(insert.promise);

    const result = await drainAudits(20);
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(before + 1);
    // Timing out is an observation, not a cancellation — the entry stays
    // registered until the insert really settles.
    expect(pendingAuditCount()).toBe(before + 1);

    insert.resolve();
    await insert.promise;
    expect(pendingAuditCount()).toBe(before);
  });

  it("a settled insert is removed either way — rejection included, with no unhandled rejection", async () => {
    const before = pendingAuditCount();
    const ok = deferred();
    const bad = deferred();
    const trackedBad = trackAudit(bad.promise);
    trackAudit(ok.promise);
    expect(pendingAuditCount()).toBe(before + 2);

    ok.resolve();
    bad.reject(new Error("sink down"));
    await expect(trackedBad).rejects.toThrow("sink down");
    await ok.promise;
    expect(pendingAuditCount()).toBe(before);
  });

  it("trackAudit returns the same promise so a caller may still await it", async () => {
    const insert = deferred<string>();
    const tracked = trackAudit(insert.promise);
    expect(tracked).toBe(insert.promise);
    insert.resolve("row");
    expect(await tracked).toBe("row");
  });

  it("drainAudits with nothing pending reports zero and drained", async () => {
    // Flush anything another suite left registered, then measure the no-op.
    await drainAudits(5_000);
    expect(pendingAuditCount()).toBe(0);
    expect(await drainAudits(5_000)).toEqual({ pending: 0, drained: true });
  });
});
