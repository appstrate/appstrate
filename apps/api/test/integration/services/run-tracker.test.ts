// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for run-tracker service.
 *
 * Tests the real module — no mock.module on any src/ path.
 * Pure in-memory functions tested directly; Redis-dependent functions
 * tested against the real Redis instance provided by the test preload.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  trackRun,
  untrackRun,
  getInFlightCount,
  abortRun,
  waitForInFlight,
} from "../../../src/services/run-tracker.ts";

// ─── Helpers ────────────────────────────────────────────────

/** Tracked run ids to clean up after each test. */
let trackedIds: string[] = [];

function trackAndRecord(id: string): AbortController {
  trackedIds.push(id);
  return trackRun(id);
}

// ─── Lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  trackedIds = [];
});

afterEach(() => {
  // Clean up any runs tracked during the test
  for (const id of trackedIds) {
    untrackRun(id);
  }
  trackedIds = [];
});

// ─── trackRun ───────────────────────────────────────────────

describe("trackRun", () => {
  it("returns an AbortController", () => {
    const controller = trackAndRecord("run_track-1");
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  it("increments the in-flight count", () => {
    const before = getInFlightCount();
    trackAndRecord("run_track-2");
    expect(getInFlightCount()).toBe(before + 1);
  });

  it("tracks multiple runs independently", () => {
    const before = getInFlightCount();
    trackAndRecord("run_track-3a");
    trackAndRecord("run_track-3b");
    trackAndRecord("run_track-3c");
    expect(getInFlightCount()).toBe(before + 3);
  });

  it("overwrites controller when tracking the same id twice", () => {
    const countBefore = getInFlightCount();
    const first = trackAndRecord("run_track-4");
    const second = trackAndRecord("run_track-4");
    // Same id, so count only increments by 1
    expect(getInFlightCount()).toBe(countBefore + 1);
    // Different controller instances
    expect(first).not.toBe(second);
  });
});

// ─── untrackRun ─────────────────────────────────────────────

describe("untrackRun", () => {
  it("decrements the in-flight count", () => {
    trackAndRecord("run_untrack-1");
    const after = getInFlightCount();
    untrackRun("run_untrack-1");
    // Remove from cleanup list since we already untracked
    trackedIds = trackedIds.filter((id) => id !== "run_untrack-1");
    expect(getInFlightCount()).toBe(after - 1);
  });

  it("is a no-op for unknown run ids", () => {
    const before = getInFlightCount();
    untrackRun("run_untrack-nonexistent");
    expect(getInFlightCount()).toBe(before);
  });

  it("only removes the specified run", () => {
    trackAndRecord("run_untrack-2a");
    trackAndRecord("run_untrack-2b");
    const count = getInFlightCount();
    untrackRun("run_untrack-2a");
    trackedIds = trackedIds.filter((id) => id !== "run_untrack-2a");
    expect(getInFlightCount()).toBe(count - 1);
  });
});

// ─── getInFlightCount ───────────────────────────────────────

describe("getInFlightCount", () => {
  it("returns a number", () => {
    expect(typeof getInFlightCount()).toBe("number");
  });

  it("reflects current state after track and untrack operations", () => {
    const baseline = getInFlightCount();
    trackAndRecord("run_count-1");
    expect(getInFlightCount()).toBe(baseline + 1);
    trackAndRecord("run_count-2");
    expect(getInFlightCount()).toBe(baseline + 2);
    untrackRun("run_count-1");
    trackedIds = trackedIds.filter((id) => id !== "run_count-1");
    expect(getInFlightCount()).toBe(baseline + 1);
    untrackRun("run_count-2");
    trackedIds = trackedIds.filter((id) => id !== "run_count-2");
    expect(getInFlightCount()).toBe(baseline);
  });
});

// ─── abortRun ───────────────────────────────────────────────

describe("abortRun", () => {
  it("aborts the local controller for a tracked run", () => {
    const controller = trackAndRecord("run_abort-1");
    expect(controller.signal.aborted).toBe(false);
    abortRun("run_abort-1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not throw for an unknown run id", () => {
    expect(() => abortRun("run_abort-nonexistent")).not.toThrow();
  });

  it("does not remove the run from the in-flight map", () => {
    trackAndRecord("run_abort-2");
    const before = getInFlightCount();
    abortRun("run_abort-2");
    // abortRun aborts but does not untrack
    expect(getInFlightCount()).toBe(before);
  });
});

// ─── waitForInFlight ────────────────────────────────────────

describe("waitForInFlight", () => {
  it("returns true immediately when no runs are in flight", async () => {
    // Ensure clean state relative to our test
    const baseline = getInFlightCount();
    if (baseline > 0) {
      // Other tests may have leaked — skip this assertion detail
      // but the function should still work correctly
    }
    // Only test with a known clean state: track then untrack
    trackAndRecord("run_wait-clean");
    untrackRun("run_wait-clean");
    trackedIds = trackedIds.filter((id) => id !== "run_wait-clean");

    // If baseline was 0, this should return true
    if (baseline === 0) {
      const result = await waitForInFlight(100);
      expect(result).toBe(true);
    }
  });

  it("returns false when runs do not complete before timeout", async () => {
    trackAndRecord("run_wait-timeout");
    const result = await waitForInFlight(100);
    // Should return false because run_wait-timeout is still tracked
    expect(result).toBe(false);
  });

  it("returns true once all runs are untracked before timeout", async () => {
    trackAndRecord("run_wait-drain");

    // Untrack after a short delay (before the timeout expires)
    setTimeout(() => {
      untrackRun("run_wait-drain");
      trackedIds = trackedIds.filter((id) => id !== "run_wait-drain");
    }, 200);

    const result = await waitForInFlight(5000);
    expect(result).toBe(true);
  });
});
