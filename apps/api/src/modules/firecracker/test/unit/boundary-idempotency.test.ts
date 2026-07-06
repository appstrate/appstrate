// SPDX-License-Identifier: Apache-2.0

/**
 * Boundary create/remove idempotency tests for the FirecrackerOrchestrator
 * (P1: replayed `POST /v1/boundaries` used to allocate a SECOND TAP +
 * subnet index for the same runId, and removeBoundary only tore down one —
 * a captured/replayed request became a resource leak + admission DoS).
 *
 * Contract pinned here:
 *   - one boundary per runId — a duplicate create (sequential replay OR a
 *     concurrent race) throws BoundaryExistsError and allocates nothing;
 *   - remove frees the subnet index and the record exactly once — a second
 *     or concurrent remove is a safe no-op (no double TAP delete, which
 *     could kill a NEW run that re-drew the same index);
 *   - transient TAP-delete failures (kernel still releasing the fd) are
 *     retried before the index is conservatively kept reserved.
 *
 * Same no-KVM setup as firecracker-orchestrator.test.ts: host commands are
 * faked, the initialization gate is bypassed via Reflect.
 */

import { describe, it, expect } from "bun:test";
import { FirecrackerOrchestrator } from "../../orchestrator.ts";
import { BoundaryExistsError } from "../../runner/protocol.ts";
import type { HostExec } from "../../host-net.ts";
import {
  fakeHostExec as fakeExec,
  defaultRespond,
  type RecordedCall,
} from "../helpers/fake-host-exec.ts";
import {
  installFirecrackerDataDir,
  readyOrchestrator as readyOrch,
  reservedIndexes,
  vmCount,
} from "../helpers/orchestrator-fixture.ts";

function readyOrchestrator(exec: HostExec): FirecrackerOrchestrator {
  const orch = readyOrch(exec);
  // Teardown retry backoff shrunk from the production 200ms base — the
  // retry-path tests below exercise up to 3 attempts.
  Reflect.set(orch, "cleanupRetryBaseMs", 1);
  return orch;
}

/** TAP creations issued so far (one `ip -batch -` run per boundary). */
function tapCreates(calls: RecordedCall[]): number {
  return calls.filter((c) => c.cmd.join(" ") === "ip -batch -").length;
}

/** TAP deletions issued so far for a device. */
function tapDeletes(calls: RecordedCall[], device: string): number {
  return calls.filter((c) => c.cmd.join(" ") === `ip link del ${device}`).length;
}

installFirecrackerDataDir("fc-bound-test-");

describe("createIsolationBoundary replay guard", () => {
  it("rejects a sequential replay for the same runId with exactly one allocation", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_replay");
    expect(boundary.name).toBe("firecracker-run_replay");

    // The replayed create must allocate NOTHING — not a TAP, not an index.
    await expect(orch.createIsolationBoundary("run_replay")).rejects.toBeInstanceOf(
      BoundaryExistsError,
    );
    expect(tapCreates(calls)).toBe(1);
    expect(reservedIndexes(orch).size).toBe(1);
    expect(vmCount(orch)).toBe(1);
  });

  it("lets exactly one of two CONCURRENT duplicate creates through", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    // Check-then-act would let both pass (the record lands in `vms` only
    // after several awaits) — the in-flight set must make this atomic.
    const results = await Promise.allSettled([
      orch.createIsolationBoundary("run_race"),
      orch.createIsolationBoundary("run_race"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(BoundaryExistsError);
    expect(tapCreates(calls)).toBe(1);
    expect(reservedIndexes(orch).size).toBe(1);
    expect(vmCount(orch)).toBe(1);
  });

  it("allows the runId again after its boundary is removed (fresh run, not a replay)", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_again");
    await orch.removeIsolationBoundary(boundary);
    expect(reservedIndexes(orch).size).toBe(0);

    // Teardown complete — the guard must not poison the runId forever.
    await orch.createIsolationBoundary("run_again");
    expect(tapCreates(calls)).toBe(2);
    expect(reservedIndexes(orch).size).toBe(1);
  });
});

describe("removeIsolationBoundary idempotency", () => {
  it("frees the subnet index and record; a second remove is a safe no-op", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_rm");
    expect(reservedIndexes(orch).size).toBe(1);

    await orch.removeIsolationBoundary(boundary);
    expect(reservedIndexes(orch).size).toBe(0);
    expect(vmCount(orch)).toBe(0);
    expect(tapDeletes(calls, "afc1")).toBe(1);

    // Second remove: 204 semantics on the wire — resolves, deletes nothing
    // again (a double `ip link del afc1` could kill a NEW run that re-drew
    // index 1 from the allocator).
    await orch.removeIsolationBoundary(boundary);
    expect(tapDeletes(calls, "afc1")).toBe(1);
    expect(reservedIndexes(orch).size).toBe(0);
  });

  it("two CONCURRENT removes share one teardown — zero double-free", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_rmrace");
    await Promise.all([
      orch.removeIsolationBoundary(boundary),
      orch.removeIsolationBoundary(boundary),
    ]);

    expect(tapDeletes(calls, "afc1")).toBe(1);
    expect(reservedIndexes(orch).size).toBe(0);
    expect(vmCount(orch)).toBe(0);
  });
});

describe("teardown retry hardening", () => {
  it("retries a transiently failing TAP delete, then releases the index", async () => {
    // Kernel still releasing the just-killed VMM's TAP fd — the first two
    // deletes answer EBUSY, the third succeeds.
    let remainingFailures = 2;
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.join(" ") === "ip link del afc1" && remainingFailures > 0) {
        remainingFailures--;
        return new Error("RTNETLINK answers: Device or resource busy");
      }
      return defaultRespond(cmd);
    });
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_busy");
    await orch.removeIsolationBoundary(boundary);

    expect(tapDeletes(calls, "afc1")).toBe(3);
    // The eventual successful delete released the index for reuse.
    expect(reservedIndexes(orch).size).toBe(0);
    expect(vmCount(orch)).toBe(0);
  });

  it("keeps the index reserved (never double-frees) when the delete keeps failing", async () => {
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.join(" ") === "ip link del afc1") {
        return new Error("RTNETLINK answers: Device or resource busy");
      }
      return defaultRespond(cmd);
    });
    const orch = readyOrchestrator(exec);

    const boundary = await orch.createIsolationBoundary("run_stuck");
    // Teardown must still resolve (best-effort) — the run is over either way.
    await orch.removeIsolationBoundary(boundary);

    // Bounded: exactly the retry budget, not an infinite loop.
    expect(tapDeletes(calls, "afc1")).toBe(3);
    // A lingering device means the index CANNOT be handed to the next run
    // (its `ip tuntap add` would fail) — reserved until the boot sweep.
    expect(reservedIndexes(orch).size).toBe(1);
    // The record itself is gone — the admission slot is released.
    expect(vmCount(orch)).toBe(0);
  });

  it("removeJailCgroup treats an absent cgroup dir as success without burning retries", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    // ENOENT ("already gone") is handled INSIDE the retried op — it must
    // not burn retries + backoff (the cgroup path hits this on every
    // teardown when cgroups are off). A single retry would sleep 60s here,
    // well past the test timeout, so a fast clean resolve proves the first
    // attempt succeeded.
    Reflect.set(orch, "cleanupRetryBaseMs", 60_000);
    const removeJailCgroup = Reflect.get(orch, "removeJailCgroup") as (
      this: FirecrackerOrchestrator,
      jailId: string,
    ) => Promise<void>;

    // No such cgroup dir exists on this host → rmdir answers ENOENT.
    await removeJailCgroup.call(orch, "afc-no-such-jail");
  });
});
