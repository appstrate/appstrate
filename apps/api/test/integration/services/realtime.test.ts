// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import {
  addSubscriber,
  removeSubscriber,
  initRealtime,
  type RealtimeEvent,
} from "../../../src/services/realtime.ts";
import { eventData, pgNotify } from "../../helpers/sse.ts";

/**
 * Helper: wait for async PG LISTEN delivery.
 */
function wait(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Track subscriber IDs added during tests so afterEach can clean them up. */
const activeSubscribers: string[] = [];

function trackSubscriber(id: string) {
  activeSubscribers.push(id);
}

describe("realtime service (integration)", () => {
  // Initialize PG LISTEN channels once for the entire suite.
  beforeAll(async () => {
    await initRealtime();
  });

  afterEach(() => {
    // Remove all subscribers registered during the test.
    for (const id of activeSubscribers) {
      removeSubscriber(id);
    }
    activeSubscribers.length = 0;
  });

  // ── addSubscriber / removeSubscriber lifecycle ──────────────

  describe("subscriber lifecycle", () => {
    it("addSubscriber registers and removeSubscriber unregisters", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "lifecycle-sub";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-lifecycle", spaceId: "space-lifecycle" },
        send,
      });

      // Subscriber should receive matching events.
      await pgNotify("run_update", {
        org_id: "org-lifecycle",
        space_id: "space-lifecycle",
        id: "exec1",
        status: "running",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);

      // After removal, no more events.
      removeSubscriber(id);
      send.mockClear();

      await pgNotify("run_update", {
        org_id: "org-lifecycle",
        space_id: "space-lifecycle",
        id: "exec2",
        status: "running",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── run_update dispatching ────────────────────────────

  describe("run_update", () => {
    it("dispatches to subscriber matching orgId and spaceId", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-org-match";
      trackSubscriber(id);

      addSubscriber({ id, filter: { orgId: "org1", spaceId: "space1" }, send });

      await pgNotify("run_update", {
        org_id: "org1",
        space_id: "space1",
        id: "exec-1",
        status: "running",
        package_id: "pkg-1",
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]![0]!;
      expect(call.event).toBe("run_update");
      // Verify snake_case is converted to camelCase.
      expect(eventData(call, "run_update")).toMatchObject({
        orgId: "org1",
        spaceId: "space1",
        id: "exec-1",
        status: "running",
        packageId: "pkg-1",
      });
    });

    it("does not dispatch to subscriber with different orgId (cross-org isolation)", async () => {
      const sendOrg1 = mock((_e: RealtimeEvent) => {});
      const sendOrg2 = mock((_e: RealtimeEvent) => {});
      trackSubscriber("sub-org1");
      trackSubscriber("sub-org2");

      addSubscriber({
        id: "sub-org1",
        filter: { orgId: "org-alpha", spaceId: "space-alpha" },
        send: sendOrg1,
      });
      addSubscriber({
        id: "sub-org2",
        filter: { orgId: "org-beta", spaceId: "space-beta" },
        send: sendOrg2,
      });

      await pgNotify("run_update", {
        org_id: "org-alpha",
        space_id: "space-alpha",
        id: "exec-x",
        status: "success",
      });
      await wait();

      expect(sendOrg1).toHaveBeenCalledTimes(1);
      expect(sendOrg2).not.toHaveBeenCalled();
    });

    it("does not dispatch to subscriber with different spaceId (cross-space isolation)", async () => {
      const sendSpace1 = mock((_e: RealtimeEvent) => {});
      const sendSpace2 = mock((_e: RealtimeEvent) => {});
      trackSubscriber("sub-space1");
      trackSubscriber("sub-space2");

      addSubscriber({
        id: "sub-space1",
        filter: { orgId: "org-shared", spaceId: "space-one" },
        send: sendSpace1,
      });
      addSubscriber({
        id: "sub-space2",
        filter: { orgId: "org-shared", spaceId: "space-two" },
        send: sendSpace2,
      });

      await pgNotify("run_update", {
        org_id: "org-shared",
        space_id: "space-one",
        id: "exec-iso",
        status: "running",
      });
      await wait();

      expect(sendSpace1).toHaveBeenCalledTimes(1);
      expect(sendSpace2).not.toHaveBeenCalled();
    });

    it("filters by runId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-exec-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-ef", spaceId: "space-ef", runId: "target-exec" },
        send,
      });

      // Non-matching run ID should be filtered out.
      await pgNotify("run_update", {
        org_id: "org-ef",
        space_id: "space-ef",
        id: "other-exec",
        status: "running",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching run ID should be dispatched.
      await pgNotify("run_update", {
        org_id: "org-ef",
        space_id: "space-ef",
        id: "target-exec",
        status: "success",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
      expect(eventData(send.mock.calls[0]![0]!, "run_update").id).toBe("target-exec");
    });

    it("filters by packageId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-pkg-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-pf", spaceId: "space-pf", packageId: "target-pkg" },
        send,
      });

      // Non-matching package ID should be filtered out.
      await pgNotify("run_update", {
        org_id: "org-pf",
        space_id: "space-pf",
        id: "exec-a",
        status: "running",
        package_id: "wrong-pkg",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching package ID should be dispatched.
      await pgNotify("run_update", {
        org_id: "org-pf",
        space_id: "space-pf",
        id: "exec-b",
        status: "running",
        package_id: "target-pkg",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
      expect(eventData(send.mock.calls[0]![0]!, "run_update").packageId).toBe("target-pkg");
    });
  });

  // ── run_log_insert dispatching ────────────────────────

  describe("run_log_insert", () => {
    it("non-admin does not receive debug logs", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-non-admin";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-log", spaceId: "space-log", isAdmin: false },
        send,
      });

      await pgNotify("run_log_insert", {
        org_id: "org-log",
        space_id: "space-log",
        run_id: "exec-log-1",
        level: "debug",
        message: "debug info",
      });
      await wait();

      expect(send).not.toHaveBeenCalled();

      // Non-debug logs should still be received.
      await pgNotify("run_log_insert", {
        org_id: "org-log",
        space_id: "space-log",
        run_id: "exec-log-1",
        level: "info",
        message: "info log",
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.event).toBe("run_log");
    });

    it("admin receives debug logs", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-admin";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-log-admin", spaceId: "space-log-admin", isAdmin: true },
        send,
      });

      await pgNotify("run_log_insert", {
        org_id: "org-log-admin",
        space_id: "space-log-admin",
        run_id: "exec-log-2",
        level: "debug",
        message: "debug for admin",
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.event).toBe("run_log");
      expect(eventData(send.mock.calls[0]![0]!, "run_log").level).toBe("debug");
    });

    it("filters logs by runId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-log-exec-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-lef", spaceId: "space-lef", runId: "target-log-exec" },
        send,
      });

      // Non-matching run_id.
      await pgNotify("run_log_insert", {
        org_id: "org-lef",
        space_id: "space-lef",
        run_id: "other-exec",
        level: "info",
        message: "wrong exec",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching run_id.
      await pgNotify("run_log_insert", {
        org_id: "org-lef",
        space_id: "space-lef",
        run_id: "target-log-exec",
        level: "info",
        message: "right exec",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("subscriber without isAdmin defaults to filtering debug logs", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-default-admin";
      trackSubscriber(id);

      // isAdmin omitted (undefined) — should behave as non-admin.
      addSubscriber({
        id,
        filter: { orgId: "org-default", spaceId: "space-default" },
        send,
      });

      await pgNotify("run_log_insert", {
        org_id: "org-default",
        space_id: "space-default",
        run_id: "exec-d",
        level: "debug",
        message: "debug hidden",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      await pgNotify("run_log_insert", {
        org_id: "org-default",
        space_id: "space-default",
        run_id: "exec-d",
        level: "warn",
        message: "warn visible",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // ── run_metric dispatching ───────────────────────────────

  describe("run_metric", () => {
    it("dispatches to subscriber matching orgId, spaceId, and runId", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-metric-match";
      trackSubscriber(id);
      addSubscriber({
        id,
        filter: { orgId: "org-m", spaceId: "space-m", runId: "exec-m", isAdmin: true },
        send,
      });

      await pgNotify("run_metric", {
        org_id: "org-m",
        space_id: "space-m",
        run_id: "exec-m",
        package_id: "@scope/agent",
        token_usage: { input_tokens: 10, output_tokens: 5 },
        cost_so_far: 0.0042,
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]![0]!;
      expect(call.event).toBe("run_metric");
      expect(eventData(call, "run_metric")).toEqual({
        orgId: "org-m",
        spaceId: "space-m",
        runId: "exec-m",
        packageId: "@scope/agent",
        tokenUsage: { input_tokens: 10, output_tokens: 5 },
        costSoFar: 0.0042,
        costPricingStatus: null,
      });
    });

    it("filters by runId", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-metric-run-filter";
      trackSubscriber(id);
      addSubscriber({
        id,
        filter: { orgId: "org-mr", spaceId: "space-mr", runId: "target", isAdmin: true },
        send,
      });

      await pgNotify("run_metric", {
        org_id: "org-mr",
        space_id: "space-mr",
        run_id: "other",
        package_id: "@scope/agent",
        token_usage: null,
        cost_so_far: 0,
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      await pgNotify("run_metric", {
        org_id: "org-mr",
        space_id: "space-mr",
        run_id: "target",
        package_id: "@scope/agent",
        token_usage: null,
        cost_so_far: 0,
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("filters by packageId for agent-scoped streams", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-metric-pkg-filter";
      trackSubscriber(id);
      addSubscriber({
        id,
        filter: {
          orgId: "org-mp",
          spaceId: "space-mp",
          packageId: "@scope/want",
          isAdmin: true,
        },
        send,
      });

      await pgNotify("run_metric", {
        org_id: "org-mp",
        space_id: "space-mp",
        run_id: "rA",
        package_id: "@scope/skip",
        token_usage: null,
        cost_so_far: 0,
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      await pgNotify("run_metric", {
        org_id: "org-mp",
        space_id: "space-mp",
        run_id: "rB",
        package_id: "@scope/want",
        token_usage: null,
        cost_so_far: 0,
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not leak across orgs", async () => {
      const sendA = mock((_e: RealtimeEvent) => {});
      const sendB = mock((_e: RealtimeEvent) => {});
      trackSubscriber("sub-metric-orgA");
      trackSubscriber("sub-metric-orgB");
      addSubscriber({
        id: "sub-metric-orgA",
        filter: { orgId: "org-A", spaceId: "space-A", isAdmin: true },
        send: sendA,
      });
      addSubscriber({
        id: "sub-metric-orgB",
        filter: { orgId: "org-B", spaceId: "space-B", isAdmin: true },
        send: sendB,
      });

      await pgNotify("run_metric", {
        org_id: "org-A",
        space_id: "space-A",
        run_id: "x",
        package_id: "@scope/p",
        token_usage: null,
        cost_so_far: 0,
      });
      await wait();
      expect(sendA).toHaveBeenCalledTimes(1);
      expect(sendB).not.toHaveBeenCalled();
    });
  });

  // ── channel subscription filter ─────────────────────────────
  //
  // A subscriber may declare the channels it consumes. The global dashboard
  // stream reads three of the five, so without this the server serialized the
  // entire `run_log` firehose into a stream that threw every frame away.
  // Declaring nothing must keep the historical "receive everything" behaviour
  // so no existing client (CLI, SDK, integrator) loses frames.

  describe("channel filter", () => {
    it("a subscriber declaring only run_update receives no run_log frames", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-channels-runupdate";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: {
          orgId: "org-ch",
          spaceId: "space-ch",
          isAdmin: true,
          channels: new Set(["run_update"]),
        },
        send,
      });

      await pgNotify("run_log_insert", {
        org_id: "org-ch",
        space_id: "space-ch",
        run_id: "exec-ch",
        level: "info",
        message: "should not be delivered",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // The declared channel still flows — this is a filter, not a mute.
      await pgNotify("run_update", {
        org_id: "org-ch",
        space_id: "space-ch",
        id: "exec-ch",
        status: "running",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.event).toBe("run_update");
    });

    it("a subscriber declaring NO channels receives every channel (backward compatible)", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-channels-none-declared";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-ch2", spaceId: "space-ch2", isAdmin: true },
        send,
      });

      await pgNotify("run_update", {
        org_id: "org-ch2",
        space_id: "space-ch2",
        id: "exec-ch2",
        status: "running",
      });
      await wait();
      await pgNotify("run_log_insert", {
        org_id: "org-ch2",
        space_id: "space-ch2",
        run_id: "exec-ch2",
        level: "info",
        message: "still delivered",
      });
      await wait();
      await pgNotify("run_metric", {
        org_id: "org-ch2",
        space_id: "space-ch2",
        run_id: "exec-ch2",
        package_id: "pkg-ch2",
      });
      await wait();

      const received = send.mock.calls.map((c) => c[0]!.event);
      expect(received).toContain("run_update");
      expect(received).toContain("run_log");
      expect(received).toContain("run_metric");
    });

    it("filtering one subscriber does not starve another on the same channel", async () => {
      const filtered = mock((_e: RealtimeEvent) => {});
      const unfiltered = mock((_e: RealtimeEvent) => {});
      trackSubscriber("sub-ch-filtered");
      trackSubscriber("sub-ch-unfiltered");

      addSubscriber({
        id: "sub-ch-filtered",
        filter: {
          orgId: "org-ch3",
          spaceId: "space-ch3",
          isAdmin: true,
          channels: new Set(["run_update"]),
        },
        send: filtered,
      });
      addSubscriber({
        id: "sub-ch-unfiltered",
        filter: { orgId: "org-ch3", spaceId: "space-ch3", isAdmin: true },
        send: unfiltered,
      });

      await pgNotify("run_log_insert", {
        org_id: "org-ch3",
        space_id: "space-ch3",
        run_id: "exec-ch3",
        level: "info",
        message: "one wants it, one does not",
      });
      await wait();

      expect(filtered).not.toHaveBeenCalled();
      expect(unfiltered).toHaveBeenCalledTimes(1);
    });
  });

  // ── initRealtime idempotency ────────────────────────────────

  describe("initRealtime idempotency", () => {
    it("calling initRealtime multiple times does not duplicate listeners", async () => {
      // initRealtime was already called in beforeAll. Call it again.
      await initRealtime();
      await initRealtime();

      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-idempotent";
      trackSubscriber(id);

      addSubscriber({ id, filter: { orgId: "org-idem", spaceId: "space-idem" }, send });

      await pgNotify("run_update", {
        org_id: "org-idem",
        space_id: "space-idem",
        id: "exec-idem",
        status: "running",
      });
      await wait();

      // Should receive exactly one event, not duplicates.
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
