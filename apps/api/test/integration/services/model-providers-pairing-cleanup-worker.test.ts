// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing cleanup worker — covers init/shutdown wiring only. The
 * underlying `cleanupExpiredPairings` predicate is exercised in
 * `model-providers-pairings.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  initPairingCleanupWorker,
  shutdownPairingCleanupWorker,
} from "../../../src/services/model-providers/pairing-cleanup-worker.ts";
import { truncateAll } from "../../helpers/db.ts";

describe("pairing cleanup worker — init/shutdown", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(async () => {
    await shutdownPairingCleanupWorker();
  });

  it("init is idempotent and shutdown leaves no resources behind", async () => {
    await initPairingCleanupWorker();
    // Double init/shutdown must resolve (not throw / hang) — the only
    // observable contract of the worker's lifecycle wiring.
    await expect(initPairingCleanupWorker()).resolves.toBeUndefined();
    await expect(shutdownPairingCleanupWorker()).resolves.toBeUndefined();
    await expect(shutdownPairingCleanupWorker()).resolves.toBeUndefined();
  });
});
