// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { waitForSidecarHealth } from "../../src/services/sidecar-pool.ts";

/**
 * Sidecar pool tests.
 *
 * Most sidecar pool operations require Docker and live containers.
 * These tests cover the edge cases and pure logic that can be tested
 * without Docker infrastructure.
 *
 * Full integration tests for the pool lifecycle (init → acquire → replenish → shutdown)
 * run in the docker-api integration test suite.
 */

describe("waitForSidecarHealth", () => {
  it("throws after retries when health endpoint is unreachable", async () => {
    // Use a port that nothing is listening on
    try {
      await waitForSidecarHealth(1); // port 1 is almost certainly unavailable
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("health check failed");
    }
  }, 90_000); // Long timeout because it retries (full budget ~58s of delays + per-attempt fetch timeouts)
});

describe("getSidecarImage", () => {
  it("returns the configured sidecar image", async () => {
    const { getSidecarImage } = await import("../../src/services/sidecar-pool.ts");
    const image = getSidecarImage();
    // In test env, this should return the default or env-configured value
    expect(typeof image).toBe("string");
    expect(image.length).toBeGreaterThan(0);
  });
});
