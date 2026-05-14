// SPDX-License-Identifier: Apache-2.0

/**
 * Drain orchestration tests (#435).
 *
 * The signal handler in `server.ts` wires SIGTERM / SIGINT to
 * `drainRegistry`. That function (in `limiter.ts`) is fully
 * testable in isolation — we don't import `server.ts` because it has
 * port-binding side effects at module load. The signal-handler wiring
 * itself is a 3-line glue function whose behaviour is the registry +
 * exit-code contract pinned here.
 *
 * Acceptance criteria for the drain (from issue #435):
 *
 *   (a) After SIGTERM, new `provider_call` invocations return a
 *       drain signal.
 *       → covered by limiter.test.ts (`DrainingError`) + mcp.test.ts
 *         (`DRAINING` tool error) + app.test.ts (`/health` 503).
 *   (b) The in-flight calls complete.
 *       → exercised here: a parked call resolves while drain waits.
 *   (c) The process exits within the drain ceiling.
 *       → exercised here: injected `exit` callback fires with the
 *         right code, within the timeout we supplied.
 */

import { describe, it, expect } from "bun:test";
import { LimiterRegistry, drainRegistry, DEFAULT_DRAIN_TIMEOUT_MS } from "../limiter.ts";

describe("drainRegistry (#435)", () => {
  it("waits for in-flight work, then calls exit(0) when drained cleanly", async () => {
    const reg = new LimiterRegistry({ default: 2, perProvider: new Map() });
    let exitCode: number | undefined;
    const events: Array<{ phase: string; payload: Record<string, unknown> }> = [];
    let gate: (() => void) | null = null;
    const inflight = reg.run("p", async () => {
      await new Promise<void>((resolve) => {
        gate = resolve;
      });
      return "done";
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Schedule the gate release on a microtask so the drain has to
    // actually wait on onIdle().
    queueMicrotask(() => gate!());
    const result = await drainRegistry(reg, "SIGTERM", {
      timeoutMs: 1000,
      onStart: (e) => events.push({ phase: "start", payload: e }),
      onComplete: (e) => events.push({ phase: "complete", payload: e }),
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(await inflight).toBe("done");
    expect(result.idle).toBe(true);
    expect(exitCode).toBe(0);
    expect(events.map((e) => e.phase)).toEqual(["start", "complete"]);
    expect(events[0]!.payload).toEqual({ signal: "SIGTERM", timeoutMs: 1000 });
    expect(events[1]!.payload.signal).toBe("SIGTERM");
    expect(events[1]!.payload.idle).toBe(true);
  });

  it("calls exit(1) on timeout when in-flight work doesn't finish", async () => {
    const reg = new LimiterRegistry({ default: 1, perProvider: new Map() });
    let exitCode: number | undefined;
    let _release: (() => void) | null = null;
    const hung = reg.run(
      "p",
      () =>
        new Promise<void>((resolve) => {
          _release = resolve;
        }),
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const startedAt = Date.now();
    const result = await drainRegistry(reg, "SIGTERM", {
      timeoutMs: 30,
      exit: (code) => {
        exitCode = code;
      },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.idle).toBe(false);
    expect(exitCode).toBe(1);
    // 30 ms ≤ elapsed ≤ some small slack; we don't want the drain to
    // hang past the ceiling.
    expect(elapsedMs).toBeGreaterThanOrEqual(30);
    expect(elapsedMs).toBeLessThan(500);
    // Cleanup: let the hung call resolve so the test process exits.
    _release!();
    await hung;
  });

  it("rejects new runs with DrainingError after drain starts", async () => {
    const reg = new LimiterRegistry({ default: 1, perProvider: new Map() });
    // Pre-drain: runs accepted.
    await reg.run("p", async () => "ok");
    // Start the drain.
    const drained = drainRegistry(reg, "SIGTERM", {
      timeoutMs: 100,
      exit: () => {},
    });
    // New runs land on DrainingError immediately.
    await expect(reg.run("p", async () => "post-drain")).rejects.toMatchObject({
      name: "DrainingError",
    });
    await drained;
  });

  it("DEFAULT_DRAIN_TIMEOUT_MS is 30 seconds — well under the run-tracker grace window", () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(30_000);
  });
});
