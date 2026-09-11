// SPDX-License-Identifier: Apache-2.0

/**
 * `createBroadInvalidator` — the throttle behind the run-list refreshes.
 *
 * It used to re-arm its timer on every event (a trailing debounce), so a
 * sustained stream of `run_update` frames flushed NOTHING: `["agents"]`,
 * `["packages"]` and `["paginated-runs"]` stayed stale for as long as runs kept
 * moving, which is exactly when those lists matter. The property pinned below
 * is the throttle's: flush latency bounded by `delayMs` at any event rate,
 * bursts still collapsed into one flush.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { createBroadInvalidator } from "../use-global-run-sync.ts";

const DELAY_MS = 2000;

/** Records the keys the invalidator asks React Query to refetch. */
function recordingClient() {
  const keys: unknown[][] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
      keys.push(queryKey);
    },
  } as unknown as QueryClient;
  return { keys, getQueryClient: () => qc };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("createBroadInvalidator", () => {
  it("keeps flushing under a sustained 1 Hz stream", () => {
    const { keys, getQueryClient } = recordingClient();
    const broad = createBroadInvalidator(getQueryClient, DELAY_MS);

    for (let i = 0; i < 60; i++) {
      broad.schedule(["paginated-runs"]);
      jest.advanceTimersByTime(1000);
    }

    // 60s of traffic through a 2s throttle: one flush every other event, so
    // exactly 30. The debounce this replaced produced 0 on the same input —
    // that is the negative control.
    expect(keys.length).toBe(30);
    broad.dispose();
  });

  it("collapses a burst into one flush, one invalidation per distinct key", () => {
    const { keys, getQueryClient } = recordingClient();
    const broad = createBroadInvalidator(getQueryClient, DELAY_MS);

    for (let i = 0; i < 10; i++) {
      broad.schedule(["agents", "org_1"]);
      broad.schedule(["paginated-runs"]);
      jest.advanceTimersByTime(10);
    }
    expect(keys).toEqual([]);

    jest.advanceTimersByTime(DELAY_MS);
    expect(keys).toEqual([["agents", "org_1"], ["paginated-runs"]]);
    broad.dispose();
  });

  it("cancels an armed flush on dispose (unmount)", () => {
    const { keys, getQueryClient } = recordingClient();
    const broad = createBroadInvalidator(getQueryClient, DELAY_MS);

    broad.schedule(["paginated-runs"]);
    broad.dispose();
    jest.advanceTimersByTime(DELAY_MS * 2);

    expect(keys).toEqual([]);
  });
});
