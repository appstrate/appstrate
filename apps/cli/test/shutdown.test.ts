// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ShutdownCoordinator } from "../src/lib/shutdown.ts";

/**
 * Helper: builds a coordinator wired to a tiny fake `exit` so the test
 * process survives. Returns the coordinator plus a getter for the
 * captured exit codes (in call order).
 */
function makeCoordinator(timeoutMs = 50): {
  coordinator: ShutdownCoordinator;
  exitCodes: () => readonly number[];
} {
  const codes: number[] = [];
  const coordinator = new ShutdownCoordinator({
    exit: (code) => {
      codes.push(code);
    },
    timeoutMs,
  });
  return { coordinator, exitCodes: () => codes };
}

describe("ShutdownCoordinator", () => {
  it("aborts its signal as soon as trigger is called", async () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.signal.aborted).toBe(false);
    const promise = coordinator.trigger("SIGINT", 130);
    expect(coordinator.signal.aborted).toBe(true);
    await promise;
  });

  it("invokes registered hooks before exiting with the requested code", async () => {
    const { coordinator, exitCodes } = makeCoordinator();
    const calls: string[] = [];
    coordinator.onShutdown(() => {
      calls.push("a");
    });
    coordinator.onShutdown(async () => {
      await Promise.resolve();
      calls.push("b");
    });
    await coordinator.trigger("SIGTERM", 143);
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(exitCodes()).toEqual([143]);
  });

  it("preserves hook registration order", async () => {
    // Some hooks observe each other's effects (heartbeat-stop must
    // happen before the safety-net finalize, for instance), so order
    // is part of the contract — not just an implementation detail.
    const { coordinator } = makeCoordinator();
    const calls: string[] = [];
    coordinator.onShutdown(() => {
      calls.push("first");
    });
    coordinator.onShutdown(() => {
      calls.push("second");
    });
    coordinator.onShutdown(() => {
      calls.push("third");
    });
    await coordinator.trigger("SIGINT", 130);
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("isolates hook failures with allSettled semantics", async () => {
    const { coordinator, exitCodes } = makeCoordinator();
    let secondRan = false;
    coordinator.onShutdown(() => {
      throw new Error("boom");
    });
    coordinator.onShutdown(async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    coordinator.onShutdown(() => {
      secondRan = true;
    });
    await coordinator.trigger("SIGINT", 130);
    expect(secondRan).toBe(true);
    expect(exitCodes()).toEqual([130]);
  });

  it("exits even if a hook hangs forever, bounded by timeoutMs", async () => {
    // The wedged hook must not prevent the CLI from exiting — that's
    // the whole point of the bounded race. Use an unresolved promise to
    // simulate a network call frozen behind a partition.
    const { coordinator, exitCodes } = makeCoordinator(20);
    coordinator.onShutdown(() => new Promise<void>(() => {}));
    const start = Date.now();
    await coordinator.trigger("SIGINT", 130);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(exitCodes()).toEqual([130]);
  });

  it("unregister stops the hook from running", async () => {
    const { coordinator } = makeCoordinator();
    let called = false;
    const unregister = coordinator.onShutdown(() => {
      called = true;
    });
    unregister();
    await coordinator.trigger("SIGINT", 130);
    expect(called).toBe(false);
  });

  it("a second trigger short-circuits to exit without re-running hooks", async () => {
    // The second-Ctrl-C UX: the user signalled they want OUT, don't
    // re-run cleanups (which might be the thing hanging in the first place).
    const { coordinator, exitCodes } = makeCoordinator(50);
    let runCount = 0;
    coordinator.onShutdown(async () => {
      runCount++;
      // Hold the first shutdown open long enough for the second trigger
      // to land before hooks have settled.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const first = coordinator.trigger("SIGINT", 130);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await coordinator.trigger("SIGINT", 130);
    await first;
    expect(runCount).toBe(1);
    expect(exitCodes()).toEqual([130, 130]);
  });

  it("hooks registered after trigger are not invoked by the in-flight shutdown", async () => {
    // Late registrations are a programmer error, but they shouldn't
    // crash or stall the in-flight shutdown — just no-op.
    const { coordinator } = makeCoordinator();
    let lateCalled = false;
    const promise = coordinator.trigger("SIGINT", 130);
    coordinator.onShutdown(() => {
      lateCalled = true;
    });
    await promise;
    expect(lateCalled).toBe(false);
  });

  it("hook receives an aborted signal — hooks can branch on shutdown reason", async () => {
    // Hooks that need to know whether they're being called from a
    // signal vs a normal completion path can read `coordinator.signal`.
    const { coordinator } = makeCoordinator();
    const observed: { aborted: boolean | null } = { aborted: null };
    coordinator.onShutdown(() => {
      observed.aborted = coordinator.signal.aborted;
    });
    await coordinator.trigger("SIGINT", 130);
    expect(observed.aborted).toBe(true);
  });
});
