// SPDX-License-Identifier: Apache-2.0

/**
 * `patchRunDetail` — the single writer of the run-detail cache from a
 * `run_update` frame, shared by the global stream and the per-run stream
 * (whose every connection opens with a status snapshot).
 *
 * Asserted against a REAL `QueryClient`: the two things that can silently
 * break are React Query's key matching and the camelCase→`RunWireDto` field
 * mapping, and a stub would fake both.
 */

import { describe, it, expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { EnrichedRun, RunUpdateEvent } from "@appstrate/shared-types";
import { patchRunDetail } from "../use-global-run-sync.ts";
import { runKeys } from "../../lib/query-keys.ts";

const ORG = "org_1";
const SPACE = "spc_1";
const RUN = "run_1";

const FRAME: RunUpdateEvent = {
  operation: "UPDATE",
  id: RUN,
  packageId: "@acme/agent",
  status: "success",
  userId: "usr_1",
  endUserId: null,
  orgId: ORG,
  spaceId: SPACE,
  scheduleId: null,
  error: null,
  startedAt: "2026-09-07T10:00:00.000Z",
  completedAt: "2026-09-07T10:00:42.000Z",
  duration: 42_000,
};

describe("patchRunDetail", () => {
  it("writes the frame onto the cached run under the RunWireDto field names", () => {
    const qc = new QueryClient();
    qc.setQueryData(runKeys.detail(ORG, SPACE, RUN), {
      id: RUN,
      status: "running",
      started_at: null,
      completed_at: null,
      duration: null,
    });

    patchRunDetail(qc, ORG, SPACE, FRAME);

    const run = qc.getQueryData<EnrichedRun>(runKeys.detail(ORG, SPACE, RUN));
    expect(run?.status).toBe("success");
    // Snake, not `startedAt`: a naive spread would add camel keys next to the
    // stale snake ones and the page would render the old timestamps forever.
    expect(run?.started_at).toBe(FRAME.startedAt);
    expect(run?.completed_at).toBe(FRAME.completedAt);
    expect(run?.duration).toBe(42_000);
    expect(run).not.toHaveProperty("startedAt");
  });

  it("drops a non-terminal frame landing on a terminal cached run", () => {
    const qc = new QueryClient();
    qc.setQueryData(runKeys.detail(ORG, SPACE, RUN), {
      id: RUN,
      status: "success",
      started_at: FRAME.startedAt,
      completed_at: FRAME.completedAt,
      duration: 42_000,
    });

    // `openRealtimeStream` subscribes BEFORE its snapshot SELECT runs, so the
    // snapshot can be older than a `run_update` already pushed to the same
    // subscriber. A terminal run emits nothing more, so a blind spread would
    // leave the detail page reading "running" for a finished run, forever.
    const stale = patchRunDetail(qc, ORG, SPACE, {
      ...FRAME,
      status: "running",
      completedAt: null,
      duration: null,
    });

    expect(stale).toBeNull();
    const run = qc.getQueryData<EnrichedRun>(runKeys.detail(ORG, SPACE, RUN));
    expect(run?.status).toBe("success");
    expect(run?.completed_at).toBe(FRAME.completedAt);
    expect(run?.duration).toBe(42_000);
  });

  it("applies a terminal frame over a live cached run", () => {
    const qc = new QueryClient();
    qc.setQueryData(runKeys.detail(ORG, SPACE, RUN), { id: RUN, status: "running" });

    expect(patchRunDetail(qc, ORG, SPACE, FRAME)).not.toBeNull();
    expect(qc.getQueryData<EnrichedRun>(runKeys.detail(ORG, SPACE, RUN))?.status).toBe("success");
  });

  it("does not materialize a run nothing has cached", () => {
    const qc = new QueryClient();

    patchRunDetail(qc, ORG, SPACE, FRAME);

    // The frame carries 13 of ~30 fields; caching it as a full row would make
    // the detail page render a run with no agent name, no cost and no counts.
    expect(qc.getQueryData(runKeys.detail(ORG, SPACE, RUN))).toBeUndefined();
  });
});
