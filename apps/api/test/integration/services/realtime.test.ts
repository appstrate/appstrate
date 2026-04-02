// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { db } from "../../helpers/db.ts";
import { sql } from "drizzle-orm";
import {
  addSubscriber,
  removeSubscriber,
  initRealtime,
  type RealtimeEvent,
} from "../../../src/services/realtime.ts";

/**
 * Helper: fire pg_notify on a channel with a JSON payload.
 */
async function pgNotify(channel: string, payload: Record<string, unknown>) {
  await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify(payload)})`);
}

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
        filter: { orgId: "org-lifecycle" },
        send,
      });

      // Subscriber should receive matching events.
      await pgNotify("execution_update", {
        org_id: "org-lifecycle",
        id: "exec1",
        status: "running",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);

      // After removal, no more events.
      removeSubscriber(id);
      send.mockClear();

      await pgNotify("execution_update", {
        org_id: "org-lifecycle",
        id: "exec2",
        status: "running",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── execution_update dispatching ────────────────────────────

  describe("execution_update", () => {
    it("dispatches to subscriber matching orgId", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-org-match";
      trackSubscriber(id);

      addSubscriber({ id, filter: { orgId: "org1" }, send });

      await pgNotify("execution_update", {
        org_id: "org1",
        id: "exec-1",
        status: "running",
        package_id: "pkg-1",
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      const call = send.mock.calls[0]![0]!;
      expect(call.event).toBe("run_update");
      // Verify snake_case is converted to camelCase.
      expect(call.data).toEqual({
        orgId: "org1",
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
        filter: { orgId: "org-alpha" },
        send: sendOrg1,
      });
      addSubscriber({
        id: "sub-org2",
        filter: { orgId: "org-beta" },
        send: sendOrg2,
      });

      await pgNotify("execution_update", {
        org_id: "org-alpha",
        id: "exec-x",
        status: "success",
      });
      await wait();

      expect(sendOrg1).toHaveBeenCalledTimes(1);
      expect(sendOrg2).not.toHaveBeenCalled();
    });

    it("filters by runId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-exec-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-ef", runId: "target-exec" },
        send,
      });

      // Non-matching execution ID should be filtered out.
      await pgNotify("execution_update", {
        org_id: "org-ef",
        id: "other-exec",
        status: "running",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching execution ID should be dispatched.
      await pgNotify("execution_update", {
        org_id: "org-ef",
        id: "target-exec",
        status: "success",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.data.id).toBe("target-exec");
    });

    it("filters by packageId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-pkg-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-pf", packageId: "target-pkg" },
        send,
      });

      // Non-matching package ID should be filtered out.
      await pgNotify("execution_update", {
        org_id: "org-pf",
        id: "exec-a",
        status: "running",
        package_id: "wrong-pkg",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching package ID should be dispatched.
      await pgNotify("execution_update", {
        org_id: "org-pf",
        id: "exec-b",
        status: "running",
        package_id: "target-pkg",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.data.packageId).toBe("target-pkg");
    });
  });

  // ── execution_log_insert dispatching ────────────────────────

  describe("execution_log_insert", () => {
    it("non-admin does not receive debug logs", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-non-admin";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-log", isAdmin: false },
        send,
      });

      await pgNotify("execution_log_insert", {
        org_id: "org-log",
        run_id: "exec-log-1",
        level: "debug",
        message: "debug info",
      });
      await wait();

      expect(send).not.toHaveBeenCalled();

      // Non-debug logs should still be received.
      await pgNotify("execution_log_insert", {
        org_id: "org-log",
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
        filter: { orgId: "org-log-admin", isAdmin: true },
        send,
      });

      await pgNotify("execution_log_insert", {
        org_id: "org-log-admin",
        run_id: "exec-log-2",
        level: "debug",
        message: "debug for admin",
      });
      await wait();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]!.event).toBe("run_log");
      expect(send.mock.calls[0]![0]!.data.level).toBe("debug");
    });

    it("filters logs by runId when set", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const id = "sub-log-exec-filter";
      trackSubscriber(id);

      addSubscriber({
        id,
        filter: { orgId: "org-lef", runId: "target-log-exec" },
        send,
      });

      // Non-matching run_id.
      await pgNotify("execution_log_insert", {
        org_id: "org-lef",
        run_id: "other-exec",
        level: "info",
        message: "wrong exec",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      // Matching run_id.
      await pgNotify("execution_log_insert", {
        org_id: "org-lef",
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
        filter: { orgId: "org-default" },
        send,
      });

      await pgNotify("execution_log_insert", {
        org_id: "org-default",
        run_id: "exec-d",
        level: "debug",
        message: "debug hidden",
      });
      await wait();
      expect(send).not.toHaveBeenCalled();

      await pgNotify("execution_log_insert", {
        org_id: "org-default",
        run_id: "exec-d",
        level: "warn",
        message: "warn visible",
      });
      await wait();
      expect(send).toHaveBeenCalledTimes(1);
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

      addSubscriber({ id, filter: { orgId: "org-idem" }, send });

      await pgNotify("execution_update", {
        org_id: "org-idem",
        id: "exec-idem",
        status: "running",
      });
      await wait();

      // Should receive exactly one event, not duplicates.
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
