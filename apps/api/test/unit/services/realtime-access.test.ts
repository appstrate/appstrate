// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it } from "bun:test";
import type { RunLogEvent } from "@appstrate/shared-types";
import { activeSubscriberCount, initRealtime } from "../../../src/services/realtime.ts";
import {
  followRunLogs,
  subscribedChannels,
  type RealtimeCaller,
} from "../../../src/services/realtime-access.ts";

/** The `run_log_insert` LISTEN handler, captured from an injected `listen`. */
let deliverRunLog: (row: Record<string, unknown>) => void = () => {
  throw new Error("realtime not initialised");
};

beforeAll(async () => {
  await initRealtime(
    async (channel, handler) => {
      if (channel === "run_log_insert") {
        deliverRunLog = (row) => handler(JSON.stringify(row));
      }
    },
    { promise: null, installed: new Set() },
  );
});

function caller(overrides: Partial<RealtimeCaller> = {}): RealtimeCaller {
  return {
    scope: { orgId: "org_1", spaceId: "spc_1" },
    actor: { type: "user", id: "user_1" },
    permissions: new Set(["runs:read", "runs:delete"]),
    ceilingAllows: () => true,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    run_id: "run_1",
    org_id: "org_1",
    space_id: "spc_1",
    user_id: "user_1",
    end_user_id: null,
    type: "progress",
    level: "info",
    event: null,
    message: "working",
    created_at: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

/** Let the visibility check's promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("followRunLogs", () => {
  it("delivers the run's own non-debug log frames, then unsubscribes on stop", async () => {
    const before = activeSubscriberCount();
    const logs: RunLogEvent[] = [];
    const stop = followRunLogs(
      caller(),
      "run_1",
      (log) => logs.push(log),
      async () => true,
    );
    await settle();
    expect(activeSubscriberCount()).toBe(before + 1);

    deliverRunLog(row({ message: "first" }));
    // Debug lines stay out even for a caller who may read them on the SSE stream.
    deliverRunLog(row({ id: 2, level: "debug", message: "debug" }));
    deliverRunLog(row({ id: 3, run_id: "run_other", message: "other run" }));
    deliverRunLog(row({ id: 4, user_id: "user_2", message: "someone else's" }));
    expect(logs.map((l) => l.message)).toEqual(["first"]);

    stop();
    expect(activeSubscriberCount()).toBe(before);
    deliverRunLog(row({ id: 5, message: "after stop" }));
    expect(logs).toHaveLength(1);
  });

  it("registers nothing when stopped before the visibility check resolves", async () => {
    const before = activeSubscriberCount();
    let allow: (allowed: boolean) => void = () => {};
    const stop = followRunLogs(
      caller(),
      "run_1",
      () => {},
      () => new Promise<boolean>((resolve) => (allow = resolve)),
    );
    stop();
    allow(true);
    await settle();
    expect(activeSubscriberCount()).toBe(before);
  });

  it("registers nothing for a run the caller may not read", async () => {
    const before = activeSubscriberCount();
    const stop = followRunLogs(
      caller(),
      "run_1",
      () => {},
      async () => false,
    );
    await settle();
    expect(activeSubscriberCount()).toBe(before);
    stop();
  });

  it("asks nothing for a caller who may not receive `run_log`", async () => {
    let asked = false;
    const stop = followRunLogs(
      caller({ permissions: new Set(["agents:run"]) }),
      "run_1",
      () => {},
      async () => {
        asked = true;
        return true;
      },
    );
    await settle();
    expect(asked).toBe(false);
    stop();
  });
});

describe("subscribedChannels", () => {
  it("keeps the requested channels the caller may receive", () => {
    expect([
      ...subscribedChannels(
        caller({ permissions: new Set(["runs:read"]), ceilingAllows: () => false }),
        undefined,
      ),
    ]).toEqual(["run_update", "run_log", "run_metric"]);
    expect([...subscribedChannels(caller(), new Set(["run_log"]))]).toEqual(["run_log"]);
  });
});
