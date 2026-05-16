// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for {@link waitForCompactionToSettle} — the bounded poll
 * that lets Pi SDK's fire-and-forget `_runAutoCompaction` finish before
 * the runtime entrypoint exits the container. See issue #464.
 *
 * The function exists because:
 *   - Pi SDK enqueues compaction onto an internal promise queue from
 *     `_handleAgentEvent` and `session.prompt()` does NOT await it.
 *   - The entrypoint calls `process.exit(0)` immediately after
 *     `runner.run()` returns — so without this wait, a compaction LLM
 *     call started milliseconds before the resolve is killed mid-flight.
 */

import { describe, it, expect } from "bun:test";
import { waitForCompactionToSettle } from "../src/pi-runner.ts";

describe("waitForCompactionToSettle", () => {
  it("returns immediately when the session never started compacting", async () => {
    const session = { isCompacting: false };
    const start = Date.now();
    await waitForCompactionToSettle(session, undefined, {
      timeoutMs: 5_000,
      pollIntervalMs: 5,
    });
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("returns immediately when isCompacting is not a boolean (older SDK)", async () => {
    // Defends against feeding the function an SDK version that does
    // not expose `isCompacting`. The wait is best-effort — older SDKs
    // simply opt out.
    const session: { isCompacting?: boolean } = {};
    const start = Date.now();
    await waitForCompactionToSettle(session, undefined, {
      timeoutMs: 5_000,
      pollIntervalMs: 5,
    });
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waits until isCompacting flips to false", async () => {
    const session = { isCompacting: true };
    const settleAfterMs = 80;
    setTimeout(() => {
      session.isCompacting = false;
    }, settleAfterMs);

    const start = Date.now();
    await waitForCompactionToSettle(session, undefined, {
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(settleAfterMs - 20); // 20ms scheduler slop
    expect(elapsed).toBeLessThan(500);
    expect(session.isCompacting).toBe(false);
  });

  it("bails out at the timeout even if compaction never settles", async () => {
    const session = { isCompacting: true };
    const start = Date.now();
    await waitForCompactionToSettle(session, undefined, {
      timeoutMs: 100,
      pollIntervalMs: 10,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
    // Function returns silently — outer run timeout is the authoritative ceiling.
    expect(session.isCompacting).toBe(true);
  });

  it("returns early when the abort signal fires (cancellation supersedes the wait)", async () => {
    const session = { isCompacting: true };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    await waitForCompactionToSettle(session, controller.signal, {
      timeoutMs: 10_000,
      pollIntervalMs: 5,
    });
    expect(Date.now() - start).toBeLessThan(200);
    expect(session.isCompacting).toBe(true); // we did NOT wait it out
  });
});
