// SPDX-License-Identifier: Apache-2.0

/**
 * Shared no-KVM fixture for the FirecrackerOrchestrator unit tests: the env
 * save/restore hooks, a ready (initialization-gate-bypassed) orchestrator
 * factory, and the Reflect accessors into the orchestrator's private state.
 * Extracted from firecracker-orchestrator / -lifecycle / boundary-idempotency
 * / console-archive, which each rebuilt these inline.
 */

import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetFirecrackerEnvCacheForTesting as _resetCacheForTesting } from "../../runner/host-env.ts";
import { FirecrackerOrchestrator, type FirecrackerOrchestratorDeps } from "../../orchestrator.ts";
import type { HostExec } from "../../host-net.ts";

/**
 * Registers the direct-spawn env fixture at module scope: a fresh
 * FIRECRACKER_DATA_DIR per test (JAILER=off, env cache reset) with
 * save/restore in afterAll. `onDataDir` receives the fresh data dir each
 * `beforeEach` for tests that reference it directly.
 *
 * Direct-spawn is the contract these files pin; jail-mode boundary shapes
 * have their own (short-data-dir) coverage in firecracker-orchestrator.test.ts.
 */
export function installFirecrackerDataDir(
  prefix: string,
  onDataDir?: (dataDir: string) => void,
): void {
  const ORIGINAL_DATA_DIR = process.env.FIRECRACKER_DATA_DIR;
  const ORIGINAL_JAILER = process.env.FIRECRACKER_JAILER;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), prefix));
    process.env.FIRECRACKER_DATA_DIR = dataDir;
    process.env.FIRECRACKER_JAILER = "off";
    _resetCacheForTesting();
    onDataDir?.(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.FIRECRACKER_DATA_DIR;
    else process.env.FIRECRACKER_DATA_DIR = ORIGINAL_DATA_DIR;
    if (ORIGINAL_JAILER === undefined) delete process.env.FIRECRACKER_JAILER;
    else process.env.FIRECRACKER_JAILER = ORIGINAL_JAILER;
    _resetCacheForTesting();
  });
}

/**
 * A FirecrackerOrchestrator with the initialization gate bypassed (the real
 * initialize() needs Linux + KVM + built artifacts). Everything past the gate
 * is host-command driven and fully faked.
 */
export function readyOrchestrator(
  exec: HostExec,
  deps: Omit<FirecrackerOrchestratorDeps, "hostExec"> = {},
): FirecrackerOrchestrator {
  const orch = new FirecrackerOrchestrator({ hostExec: exec, ...deps });
  Reflect.set(orch, "initialized", true);
  return orch;
}

/**
 * The allocator's reserved-index set — the actual accounting, read directly
 * rather than inferred from which index the next run draws.
 */
export function reservedIndexes(orch: FirecrackerOrchestrator): Set<number> {
  const allocator = Reflect.get(orch, "allocator") as object;
  return Reflect.get(allocator, "inUse") as Set<number>;
}

/** The orchestrator's private per-run record map, via the Reflect precedent. */
export function vmsOf<T = unknown>(orch: FirecrackerOrchestrator): Map<string, T> {
  return Reflect.get(orch, "vms") as Map<string, T>;
}

/** A single private VmRecord by runId (throws if absent). */
export function getVm<T = unknown>(orch: FirecrackerOrchestrator, runId: string): T {
  const vm = vmsOf<T>(orch).get(runId);
  if (!vm) throw new Error(`no VmRecord for ${runId}`);
  return vm;
}

/** Live VM count (size of the private record map). */
export function vmCount(orch: FirecrackerOrchestrator): number {
  return vmsOf(orch).size;
}
