// SPDX-License-Identifier: Apache-2.0

/**
 * Run-capacity readiness: the flag, and the refusal every launch door raises
 * while the boot's orphan pass and first runtime initialisation are running.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ApiError } from "../../../src/lib/errors.ts";
import {
  _resetRunCapacityReadyForTesting,
  assertRunCapacityReady,
  markRunCapacityReady,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";

describe("run capacity readiness", () => {
  beforeEach(() => _resetRunCapacityReadyForTesting());
  // The preload marks the flag ready for the whole process: restore it.
  afterEach(() => markRunCapacityReady());

  it("assertRunCapacityReady() throws a 503 run_capacity_starting with Retry-After while not ready", () => {
    let caught: unknown;
    try {
      assertRunCapacityReady();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(503);
    expect(err.code).toBe("run_capacity_starting");
    expect(err.title).toBe("Service Unavailable");
    expect(err.message).toContain("Run execution is still starting up");
    expect(err.headers?.["Retry-After"]).toBe("5");
  });

  it("assertRunCapacityReady() is a no-op once ready", () => {
    markRunCapacityReady();
    expect(() => assertRunCapacityReady()).not.toThrow();
  });
});
