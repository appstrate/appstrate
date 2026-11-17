// SPDX-License-Identifier: Apache-2.0

/**
 * The two post-bind boot phases that run after `Server ready`, against a real
 * database: `bootRunCapacity()` lifts the launch refusal only once the orphan
 * pass and the runtime's first `initialize()` are both done, and
 * `bootHousekeeping()` resolves with its workers started.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { bootHousekeeping, bootRunCapacity } from "../../../src/lib/boot.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  _resetRunCapacityReadyForTesting,
  assertRunCapacityReady,
  markRunCapacityReady,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";
import { shutdownScheduleWorker } from "../../../src/services/scheduler.ts";
import { shutdownInlineCompactionWorker } from "../../../src/services/inline-compaction.ts";
import { stopRunWatchdog } from "../../../src/services/run-watchdog.ts";
import { stopRuntimeImageWarmer } from "../../../src/services/orchestrator/runtime-image-warmer.ts";
import { shutdownPersonalSpaceSweeperWorker } from "../../../src/services/personal-space-sweeper.ts";
import { shutdownPairingCleanupWorker } from "../../../src/services/model-providers/pairing-cleanup-worker.ts";
import { stopUploadGc } from "../../../src/services/uploads.ts";
import { stopFileGc } from "../../../src/services/files.ts";
import { stopStorageDeletionWorker } from "../../../src/services/storage-deletion.ts";
import { createFakeOrchestrator } from "../../helpers/run-connection-fixtures.ts";
import { truncateAll } from "../../helpers/db.ts";

describe("boot phases after the port is bound", () => {
  beforeAll(() => truncateAll());

  afterAll(async () => {
    _setOrchestratorForTesting(null);
    // The preload marks the flag ready for the whole process: restore it.
    markRunCapacityReady();
    stopRuntimeImageWarmer();
    stopUploadGc();
    stopFileGc();
    stopStorageDeletionWorker();
    await Promise.all([
      shutdownScheduleWorker(),
      shutdownInlineCompactionWorker(),
      stopRunWatchdog(),
      shutdownPersonalSpaceSweeperWorker(),
      shutdownPairingCleanupWorker(),
    ]);
  });

  it("bootRunCapacity() keeps refusing launches until the first initialize() ends", async () => {
    const calls: string[] = [];
    const initializeStarted = Promise.withResolvers<void>();
    const releaseInitialize = Promise.withResolvers<void>();
    const fake = createFakeOrchestrator();
    _setOrchestratorForTesting({
      ...fake,
      async cleanupOrphans() {
        calls.push("cleanupOrphans");
        return fake.cleanupOrphans();
      },
      async initialize() {
        calls.push("initialize");
        initializeStarted.resolve();
        await releaseInitialize.promise;
      },
    });
    _resetRunCapacityReadyForTesting();

    const phase = bootRunCapacity();
    await initializeStarted.promise;
    // Orphan cleanup is over, the runtime is not initialised yet: still refused.
    expect(calls).toEqual(["cleanupOrphans", "initialize"]);
    expect(() => assertRunCapacityReady()).toThrow();

    releaseInitialize.resolve();
    await phase;
    expect(() => assertRunCapacityReady()).not.toThrow();
  });

  it("bootHousekeeping() resolves on an empty database", async () => {
    await expect(bootHousekeeping()).resolves.toBeUndefined();
  });
});
