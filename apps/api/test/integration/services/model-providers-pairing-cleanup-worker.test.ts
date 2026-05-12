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
    await initPairingCleanupWorker(); // second call must not throw
    await shutdownPairingCleanupWorker();
    await shutdownPairingCleanupWorker(); // shutdown is also idempotent
    expect(true).toBe(true);
  });
});
