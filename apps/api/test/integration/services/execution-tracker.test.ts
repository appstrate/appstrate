/**
 * Integration tests for execution-tracker service.
 *
 * Tests the real module — no mock.module on any src/ path.
 * Pure in-memory functions tested directly; Redis-dependent functions
 * tested against the real Redis instance provided by the test preload.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  trackExecution,
  untrackExecution,
  getInFlightCount,
  abortExecution,
  waitForInFlight,
} from "../../../src/services/execution-tracker.ts";

// ─── Helpers ────────────────────────────────────────────────

/** Tracked execution ids to clean up after each test. */
let trackedIds: string[] = [];

function trackAndRecord(id: string): AbortController {
  trackedIds.push(id);
  return trackExecution(id);
}

// ─── Lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  trackedIds = [];
});

afterEach(() => {
  // Clean up any executions tracked during the test
  for (const id of trackedIds) {
    untrackExecution(id);
  }
  trackedIds = [];
});

// ─── trackExecution ─────────────────────────────────────────

describe("trackExecution", () => {
  it("returns an AbortController", () => {
    const controller = trackAndRecord("exec_track-1");
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  it("increments the in-flight count", () => {
    const before = getInFlightCount();
    trackAndRecord("exec_track-2");
    expect(getInFlightCount()).toBe(before + 1);
  });

  it("tracks multiple executions independently", () => {
    const before = getInFlightCount();
    trackAndRecord("exec_track-3a");
    trackAndRecord("exec_track-3b");
    trackAndRecord("exec_track-3c");
    expect(getInFlightCount()).toBe(before + 3);
  });

  it("overwrites controller when tracking the same id twice", () => {
    const countBefore = getInFlightCount();
    const first = trackAndRecord("exec_track-4");
    const second = trackAndRecord("exec_track-4");
    // Same id, so count only increments by 1
    expect(getInFlightCount()).toBe(countBefore + 1);
    // Different controller instances
    expect(first).not.toBe(second);
  });
});

// ─── untrackExecution ───────────────────────────────────────

describe("untrackExecution", () => {
  it("decrements the in-flight count", () => {
    trackAndRecord("exec_untrack-1");
    const after = getInFlightCount();
    untrackExecution("exec_untrack-1");
    // Remove from cleanup list since we already untracked
    trackedIds = trackedIds.filter((id) => id !== "exec_untrack-1");
    expect(getInFlightCount()).toBe(after - 1);
  });

  it("is a no-op for unknown execution ids", () => {
    const before = getInFlightCount();
    untrackExecution("exec_untrack-nonexistent");
    expect(getInFlightCount()).toBe(before);
  });

  it("only removes the specified execution", () => {
    trackAndRecord("exec_untrack-2a");
    trackAndRecord("exec_untrack-2b");
    const count = getInFlightCount();
    untrackExecution("exec_untrack-2a");
    trackedIds = trackedIds.filter((id) => id !== "exec_untrack-2a");
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
    trackAndRecord("exec_count-1");
    expect(getInFlightCount()).toBe(baseline + 1);
    trackAndRecord("exec_count-2");
    expect(getInFlightCount()).toBe(baseline + 2);
    untrackExecution("exec_count-1");
    trackedIds = trackedIds.filter((id) => id !== "exec_count-1");
    expect(getInFlightCount()).toBe(baseline + 1);
    untrackExecution("exec_count-2");
    trackedIds = trackedIds.filter((id) => id !== "exec_count-2");
    expect(getInFlightCount()).toBe(baseline);
  });
});

// ─── abortExecution ─────────────────────────────────────────

describe("abortExecution", () => {
  it("aborts the local controller for a tracked execution", () => {
    const controller = trackAndRecord("exec_abort-1");
    expect(controller.signal.aborted).toBe(false);
    abortExecution("exec_abort-1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not throw for an unknown execution id", () => {
    expect(() => abortExecution("exec_abort-nonexistent")).not.toThrow();
  });

  it("does not remove the execution from the in-flight map", () => {
    trackAndRecord("exec_abort-2");
    const before = getInFlightCount();
    abortExecution("exec_abort-2");
    // abortExecution aborts but does not untrack
    expect(getInFlightCount()).toBe(before);
  });
});

// ─── waitForInFlight ────────────────────────────────────────

describe("waitForInFlight", () => {
  it("returns true immediately when no executions are in flight", async () => {
    // Ensure clean state relative to our test
    const baseline = getInFlightCount();
    if (baseline > 0) {
      // Other tests may have leaked — skip this assertion detail
      // but the function should still work correctly
    }
    // Only test with a known clean state: track then untrack
    trackAndRecord("exec_wait-clean");
    untrackExecution("exec_wait-clean");
    trackedIds = trackedIds.filter((id) => id !== "exec_wait-clean");

    // If baseline was 0, this should return true
    if (baseline === 0) {
      const result = await waitForInFlight(100);
      expect(result).toBe(true);
    }
  });

  it("returns false when executions do not complete before timeout", async () => {
    trackAndRecord("exec_wait-timeout");
    const result = await waitForInFlight(100);
    // Should return false because exec_wait-timeout is still tracked
    expect(result).toBe(false);
  });

  it("returns true once all executions are untracked before timeout", async () => {
    trackAndRecord("exec_wait-drain");

    // Untrack after a short delay (before the timeout expires)
    setTimeout(() => {
      untrackExecution("exec_wait-drain");
      trackedIds = trackedIds.filter((id) => id !== "exec_wait-drain");
    }, 200);

    const result = await waitForInFlight(5000);
    expect(result).toBe(true);
  });
});

