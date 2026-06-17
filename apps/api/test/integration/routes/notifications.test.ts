// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  addOrgMember,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedEndUser, seedApplication } from "../../helpers/seed.ts";
import {
  createRunNotifications,
  markNotificationReadByRun,
} from "../../../src/services/state/notifications.ts";
import { deleteEndUser } from "../../../src/services/end-users.ts";
import { removeMember } from "../../../src/services/organizations.ts";
import { db } from "@appstrate/db/client";
import { notifications } from "@appstrate/db/schema";
import { and, eq, sql } from "drizzle-orm";

const app = getTestApp();

interface NotificationDto {
  id: string;
  type: string;
  run_id: string | null;
  payload: { agent_id?: string; status?: string } | null;
  read_at: string | null;
  created_at: string;
}

describe("Notifications API (per-recipient, issue #667)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notiforg" });
  });

  const scope = () => ({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

  /** Headers for an arbitrary user acting within ctx's org/app. */
  function headersFor(user: { cookie: string }): Record<string, string> {
    return {
      Cookie: user.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
    };
  }

  /**
   * Seed an agent + a run, then run the real fan-out. Returns the run record.
   * `actor` controls the recipient model: own user, an end-user, or none
   * (schedule / actor-less → fan out to all org members).
   */
  async function seedNotifiedRun(opts: {
    agentName?: string;
    actor: { userId: string } | { endUserId: string } | "schedule";
    status?: "success" | "failed";
  }) {
    const agentName = opts.agentName ?? "notif-agent";
    const id = `@notiforg/${agentName}`;
    await seedAgent({ id, orgId: ctx.orgId, createdBy: ctx.user.id }).catch(() => {});
    const run = await seedRun({
      packageId: id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: opts.status ?? "success",
      ...(opts.actor === "schedule" ? {} : opts.actor),
    });
    await createRunNotifications(scope(), run.id);
    return run;
  }

  async function unreadCount(headers: Record<string, string>): Promise<number> {
    const res = await app.request("/api/notifications/unread-count", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { count: number }).count;
  }

  async function listNotifications(headers: Record<string, string>): Promise<NotificationDto[]> {
    const res = await app.request("/api/notifications?unread=true", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: NotificationDto[] }).data;
  }

  // ─── Fan-out ───────────────────────────────────────────────

  describe("fan-out on finalize", () => {
    it("creates exactly one notification for a dashboard-user run", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("end-user run notifies the end-user, not org members", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "External",
      });
      await seedNotifiedRun({ agentName: "eu-agent", actor: { endUserId: eu.id } });

      // The triggering org member is NOT a recipient.
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("actor-less run fans out to org admins/owners only, not plain members", async () => {
      const admin = await createTestUser();
      await addOrgMember(ctx.orgId, admin.id, "admin");
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");

      await seedNotifiedRun({ agentName: "sched-agent", actor: "schedule" });

      // ctx.user is the org owner → recipient; the admin → recipient.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
      expect(await unreadCount(headersFor(admin))).toBe(1);
      // Plain member is NOT a recipient.
      expect(await unreadCount(headersFor(member))).toBe(0);
    });

    it("is idempotent — a second fan-out for the same run creates no duplicate", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const again = await createRunNotifications(scope(), run.id);

      expect(again).toBe(0); // unique guard → onConflictDoNothing
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("carries a failed run's status through to the payload", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id }, status: "failed" });

      const data = await listNotifications(authHeaders(ctx));
      expect(data).toHaveLength(1);
      expect(data[0]!.run_id).toBe(run.id);
      expect(data[0]!.payload?.status).toBe("failed");
    });

    it("is exactly-once under a concurrent double fan-out (unique index, not just app logic)", async () => {
      // Seed the run without fanning out, then fire the fan-out twice
      // concurrently — the partial unique indexes must enforce a single row
      // even when onConflictDoNothing races with itself.
      await seedAgent({
        id: "@notiforg/race-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      }).catch(() => {});
      const run = await seedRun({
        packageId: "@notiforg/race-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        status: "success",
        userId: ctx.user.id,
      });

      const [a, b] = await Promise.all([
        createRunNotifications(scope(), run.id),
        createRunNotifications(scope(), run.id),
      ]);
      // Exactly one of the two racers wins the insert; the other no-ops.
      expect(a + b).toBe(1);

      const rows = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.runId, run.id));
      expect(rows).toHaveLength(1);
    });
  });

  // ─── GET /api/notifications ─────────────────────────────────

  describe("GET /api/notifications", () => {
    it("returns the recipient's notifications with payload", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const data = await listNotifications(authHeaders(ctx));
      expect(data).toHaveLength(1);
      expect(data[0]!.run_id).toBe(run.id);
      expect(data[0]!.type).toBe("run_completed");
      expect(data[0]!.payload?.agent_id).toBe("@notiforg/notif-agent");
      expect(data[0]!.payload?.status).toBe("success");
      expect(data[0]!.read_at).toBeNull();
    });

    it("unread=true hides already-read notifications", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const data = await listNotifications(authHeaders(ctx));
      const id = data[0]!.id;

      await app.request(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(await listNotifications(authHeaders(ctx))).toHaveLength(0);
      // …but still present without the filter.
      const all = await app.request("/api/notifications", { headers: authHeaders(ctx) });
      const allBody = (await all.json()) as { data: NotificationDto[]; has_more: boolean };
      expect(allBody.data).toHaveLength(1);
      expect(allBody.has_more).toBe(false);
      expect(allBody.data[0]!.run_id).toBe(run.id);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/notifications");
      expect(res.status).toBe(401);
    });
  });

  // ─── PUT /api/notifications/{id}/read ───────────────────────

  describe("PUT /api/notifications/{id}/read", () => {
    it("marks the recipient's notification read (count drops)", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      const res = await app.request(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("is idempotent — already-read returns 204", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;
      const headers = authHeaders(ctx);

      const first = await app.request(`/api/notifications/${id}/read`, { method: "PUT", headers });
      expect(first.status).toBe(204);
      const second = await app.request(`/api/notifications/${id}/read`, { method: "PUT", headers });
      expect(second.status).toBe(204);
    });

    it("returns 404 for an unknown notification id", async () => {
      const res = await app.request(
        "/api/notifications/00000000-0000-0000-0000-000000000000/read",
        { method: "PUT", headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when a member tries to mark another member's notification (the bug)", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id);

      // A run owned by user A → only A gets a notification.
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      // User B (same org) cannot mark A's notification — 404, not a silent 204.
      const res = await app.request(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: headersFor(userB),
      });
      expect(res.status).toBe(404);
      // A's notification is untouched.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });
  });

  // ─── Per-user read isolation (core of issue #667) ───────────

  describe("per-user read isolation", () => {
    it("A marking a fanned-out notification read leaves B's unread", async () => {
      const userB = await createTestUser();
      // Both admins so the actor-less run fans out to each of them.
      await addOrgMember(ctx.orgId, userB.id, "admin");

      // Actor-less run → one notification each for A (owner) and B (admin).
      await seedNotifiedRun({ agentName: "iso-agent", actor: "schedule" });
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
      expect(await unreadCount(headersFor(userB))).toBe(1);

      // A marks their own copy read.
      const aId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      const res = await app.request(`/api/notifications/${aId}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(204);

      // A is now read, B is still unread — the bug is fixed.
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      expect(await unreadCount(headersFor(userB))).toBe(1);
    });
  });

  // ─── PUT /api/notifications/read-all ────────────────────────

  describe("PUT /api/notifications/read-all", () => {
    it("marks only the caller's notifications read", async () => {
      const userB = await createTestUser();
      // Admin so the actor-less run fans out to B too.
      await addOrgMember(ctx.orgId, userB.id, "admin");
      await seedNotifiedRun({ agentName: "all-agent", actor: "schedule" });

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);

      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      // B's copy is untouched.
      expect(await unreadCount(headersFor(userB))).toBe(1);
    });

    it("returns 0 when nothing is unread", async () => {
      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(0);
    });
  });

  // ─── GET /api/notifications/unread-counts-by-agent ──────────

  describe("GET /api/notifications/unread-counts-by-agent", () => {
    it("groups unread counts by agent id from the payload", async () => {
      await seedNotifiedRun({ agentName: "agent-a", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "agent-a", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "agent-b", actor: { userId: ctx.user.id } });

      const res = await app.request("/api/notifications/unread-counts-by-agent", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const counts = ((await res.json()) as { counts: Record<string, number> }).counts;
      expect(counts["@notiforg/agent-a"]).toBe(2);
      expect(counts["@notiforg/agent-b"]).toBe(1);
    });
  });

  // ─── PUT /api/notifications/read/{runId} (mark-by-run) ──

  describe("PUT /api/notifications/read/{runId}", () => {
    it("marks the caller's notification for a run read", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const res = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("is an idempotent ack for an unknown run (204, never 404)", async () => {
      const res = await app.request(
        "/api/notifications/read/00000000-0000-0000-0000-000000000000",
        { method: "PUT", headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(204);
    });
  });

  // ─── Tenant isolation ───────────────────────────────────────

  describe("org isolation", () => {
    it("a notification in another org is invisible", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const otherCtx = await createTestContext({ orgSlug: "othernotiforg" });
      expect(await unreadCount(authHeaders(otherCtx))).toBe(0);
    });
  });

  // ─── createRunNotifications edge cases ──────────────────────

  describe("createRunNotifications edge cases", () => {
    it("returns 0 for an unknown run id and never throws (best-effort contract)", async () => {
      const n = await createRunNotifications(scope(), "exec_does_not_exist");
      expect(n).toBe(0);
    });

    it("positively creates exactly one row for the end-user recipient", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU positive",
      });
      const run = await seedNotifiedRun({ agentName: "eu-pos", actor: { endUserId: eu.id } });

      const rows = await db
        .select({
          recipientType: notifications.recipientType,
          recipientId: notifications.recipientId,
        })
        .from(notifications)
        .where(eq(notifications.runId, run.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipientType).toBe("end_user");
      expect(rows[0]!.recipientId).toBe(eu.id);
    });
  });

  // ─── end-user recipient mark path (polymorphic actorMatch) ──
  //
  // The recipient filter matches both recipientType and recipientId, so an
  // end-user marks only end-user rows and a dashboard user never matches an
  // end-user row (and vice-versa) — even when the two ids share a value.

  describe("end-user recipient mark path", () => {
    const readAtOf = async (runId: string): Promise<Date | null> => {
      const [row] = await db
        .select({ readAt: notifications.readAt })
        .from(notifications)
        .where(eq(notifications.runId, runId));
      return row!.readAt;
    };

    it("an end-user actor marks their own notification read", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU mark",
      });
      const run = await seedNotifiedRun({ agentName: "eu-mark", actor: { endUserId: eu.id } });
      expect(await readAtOf(run.id)).toBeNull();

      await markNotificationReadByRun(scope(), run.id, { type: "end_user", id: eu.id });
      expect(await readAtOf(run.id)).not.toBeNull();
    });

    it("a dashboard user does NOT match an end-user's notification row", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU isolated",
      });
      const run = await seedNotifiedRun({ agentName: "eu-iso", actor: { endUserId: eu.id } });

      // Same id value passed under the wrong actor type must not clear the row.
      await markNotificationReadByRun(scope(), run.id, { type: "user", id: eu.id });
      expect(await readAtOf(run.id)).toBeNull();
    });
  });

  // ─── recipient NOT NULL (polymorphic recipient integrity) ───

  describe("recipient columns are NOT NULL", () => {
    // The polymorphic recipient is two plain NOT NULL columns — no XOR CHECK to
    // maintain. The schema types make both required at compile time; this is
    // the DB-level guard that a raw insert omitting recipient_id is rejected
    // (SQLSTATE 23502), so the integrity does not rest on the TS layer alone.
    async function expectNotNullViolation(p: Promise<unknown>, column: string): Promise<void> {
      let err: unknown;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      expect(err, "expected the insert to be rejected by NOT NULL").toBeDefined();
      const cause = (err as { cause?: { message?: string } })?.cause;
      const detail = String(cause?.message ?? cause ?? (err as Error)?.message ?? err);
      // 23502 = not_null_violation; the column name surfaces in the message.
      expect(detail).toContain(column);
    }

    it("rejects a row with no recipient_id", async () => {
      await expectNotNullViolation(
        db.execute(
          sql`INSERT INTO notifications (org_id, application_id, recipient_type, type)
              VALUES (${ctx.orgId}, ${ctx.defaultAppId}, 'user', 'run_completed')`,
        ),
        "recipient_id",
      );
    });

    it("rejects a row with no recipient_type", async () => {
      await expectNotNullViolation(
        db.execute(
          sql`INSERT INTO notifications (org_id, application_id, recipient_id, type)
              VALUES (${ctx.orgId}, ${ctx.defaultAppId}, ${ctx.user.id}, 'run_completed')`,
        ),
        "recipient_type",
      );
    });

    it("rejects an unknown recipient_type via the CHECK (not just the TS union)", async () => {
      let err: unknown;
      try {
        await db.execute(
          sql`INSERT INTO notifications (org_id, application_id, recipient_type, recipient_id, type)
              VALUES (${ctx.orgId}, ${ctx.defaultAppId}, 'robot', ${ctx.user.id}, 'run_completed')`,
        );
      } catch (e) {
        err = e;
      }
      expect(err, "expected the insert to be rejected by the CHECK").toBeDefined();
      const cause = (err as { cause?: { message?: string } })?.cause;
      const detail = String(cause?.message ?? cause ?? (err as Error)?.message ?? err);
      expect(detail).toContain("notifications_recipient_type_valid");
    });
  });

  // ─── recipient cleanup on deletion (replaces FK cascade) ────
  //
  // The polymorphic recipientId carries no foreign key, so deleting a
  // user/end-user does not cascade their notifications. The deletion sites
  // (deleteEndUser, removeMember) clean them up explicitly — covered here.

  describe("recipient cleanup on deletion", () => {
    const countForRecipient = async (type: "user" | "end_user", id: string): Promise<number> => {
      const rows = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.recipientType, type), eq(notifications.recipientId, id)));
      return rows.length;
    };

    it("deleteEndUser removes the end-user's notifications (incl. run-less)", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU cleanup",
      });
      // A run-less notification: only the explicit cleanup (not the run
      // cascade) can remove this one — proves the delete is real, not
      // incidental to the end-user's runs cascading.
      await db.insert(notifications).values({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        recipientType: "end_user",
        recipientId: eu.id,
        type: "run_completed",
        payload: { status: "success" },
      });
      expect(await countForRecipient("end_user", eu.id)).toBe(1);

      await deleteEndUser(scope(), eu.id);
      expect(await countForRecipient("end_user", eu.id)).toBe(0);
    });

    it("removeMember removes the departing member's notifications, leaving others", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");
      // Actor-less run → one notification each for the owner (A) and admin (B).
      await seedNotifiedRun({ agentName: "cleanup-agent", actor: "schedule" });
      expect(await countForRecipient("user", userB.id)).toBe(1);
      expect(await countForRecipient("user", ctx.user.id)).toBe(1);

      await removeMember(ctx.orgId, userB.id);

      // B's notification is gone; A (still a member) keeps theirs.
      expect(await countForRecipient("user", userB.id)).toBe(0);
      expect(await countForRecipient("user", ctx.user.id)).toBe(1);
    });
  });

  // ─── unread-counts-by-agent: null agent_id ──────────────────

  describe("GET /api/notifications/unread-counts-by-agent (null agent_id)", () => {
    it("skips notifications whose payload carries no agent_id", async () => {
      await seedNotifiedRun({ agentName: "has-agent", actor: { userId: ctx.user.id } });
      // Hand-insert a notification with a payload that lacks agent_id.
      await db.insert(notifications).values({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        recipientType: "user",
        recipientId: ctx.user.id,
        type: "run_completed",
        payload: { status: "success" },
      });

      const res = await app.request("/api/notifications/unread-counts-by-agent", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const counts = ((await res.json()) as { counts: Record<string, number> }).counts;
      expect(counts["@notiforg/has-agent"]).toBe(1);
      // The null-agent_id row is surfaced under no key at all.
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  // ─── GET /api/notifications keyset pagination + ordering ────

  describe("GET /api/notifications keyset pagination", () => {
    /** Parse the `?startingAfter=<id>` cursor out of a `rel="next"` Link. */
    function nextCursor(linkHeader: string | null): string | null {
      if (!linkHeader) return null;
      const m = linkHeader.match(/[?&]startingAfter=([^&>]+)>;\s*rel="next"/);
      return m ? decodeURIComponent(m[1]!) : null;
    }

    it("orders newest-first and exposes a next-page cursor when more remain", async () => {
      await seedNotifiedRun({ agentName: "p1", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "p2", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "p3", actor: { userId: ctx.user.id } });

      const res = await app.request("/api/notifications?limit=2", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: NotificationDto[]; has_more: boolean };
      expect(body.data).toHaveLength(2);
      expect(body.has_more).toBe(true);
      // created_at descending (newest first).
      expect(new Date(body.data[0]!.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(body.data[1]!.created_at).getTime(),
      );
      // A further page exists → RFC 5988 next link carrying the keyset cursor.
      expect(nextCursor(res.headers.get("Link"))).toBe(body.data[1]!.id);
    });

    it("walks every page with no skip or duplicate, has_more flips false at the end", async () => {
      // 5 notifications, paged 2 at a time → pages of [2, 2, 1].
      for (let i = 0; i < 5; i++) {
        await seedNotifiedRun({ agentName: `walk-${i}`, actor: { userId: ctx.user.id } });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      // Bound the loop defensively so a pagination bug fails fast, not hangs.
      while (pages < 10) {
        pages++;
        const url: string =
          "/api/notifications?limit=2" + (cursor ? `&startingAfter=${cursor}` : "");
        const res = await app.request(url, { headers: authHeaders(ctx) });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: NotificationDto[]; has_more: boolean };
        seen.push(...body.data.map((n) => n.id));
        if (!body.has_more) break;
        cursor = body.data.at(-1)!.id;
        expect(cursor).not.toBeNull();
      }

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      // No duplicates across pages.
      expect(new Set(seen).size).toBe(5);
      // Strictly newest-first across the whole walk (ids are random, so assert
      // via created_at by re-reading is overkill — the per-page order assertion
      // above plus the no-dup/no-skip set check pins the keyset invariant).
    });

    it("an unread filter paginates independently of read rows", async () => {
      for (let i = 0; i < 3; i++) {
        await seedNotifiedRun({ agentName: `uf-${i}`, actor: { userId: ctx.user.id } });
      }
      // Mark the newest one read.
      const firstId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await app.request(`/api/notifications/${firstId}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      const res = await app.request("/api/notifications?unread=true&limit=2", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { data: NotificationDto[]; has_more: boolean };
      // 2 unread remain → exactly one page, no more.
      expect(body.data).toHaveLength(2);
      expect(body.has_more).toBe(false);
      expect(body.data.some((n) => n.id === firstId)).toBe(false);
    });
  });

  // ─── mark isolation: cross-org + by-run non-recipient ───────

  describe("mark isolation", () => {
    it("returns 404 marking a notification that belongs to another org", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      const otherCtx = await createTestContext({ orgSlug: "wrongorg" });
      const res = await app.request(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: authHeaders(otherCtx),
      });
      expect(res.status).toBe(404);
      // Untouched for the real recipient.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("PUT read/{runId} is a no-op for a non-recipient (204, owner stays unread)", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "member");
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const res = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: headersFor(userB),
      });
      expect(res.status).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("PUT read/{runId} is idempotent on a second ack", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const h = authHeaders(ctx);
      const first = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: h,
      });
      expect(first.status).toBe(204);
      const second = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: h,
      });
      expect(second.status).toBe(204);
      expect(await unreadCount(h)).toBe(0);
    });
  });

  // ─── read-all counts only the unread subset ─────────────────

  describe("PUT /api/notifications/read-all (mixed read/unread)", () => {
    it("counts only the still-unread notifications", async () => {
      await seedNotifiedRun({ agentName: "mix1", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "mix2", actor: { userId: ctx.user.id } });
      // Mark one of the two read up front.
      const firstId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await app.request(`/api/notifications/${firstId}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      // Only the remaining unread one is flipped.
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });
  });

  // ─── Cross-application isolation (same org, different app) ───

  describe("cross-application isolation", () => {
    it("a notification in app A is invisible from app B in the same org", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } }); // app = ctx.defaultAppId
      const appB = await seedApplication({ orgId: ctx.orgId, name: "App B" });
      const headersB = {
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": appB.id,
      };

      expect(await unreadCount(headersB)).toBe(0);
      // …still visible in app A.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });
  });

  // ─── Per-recipient `unread` flag on enriched runs (badge source) ──
  //
  // The run-list / schedule-card unread badges read `EnrichedRun.unread`,
  // derived from the notifications table for the requesting actor (issue
  // #667). No `runs.notifiedAt` / `runs.readAt` columns exist any more — the
  // notifications table is the single source of read-state.

  describe("enriched run `unread` flag", () => {
    const unreadOf = async (
      headers: Record<string, string>,
      runId: string,
    ): Promise<boolean | undefined> => {
      const res = await app.request("/api/runs", { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; unread: boolean }> };
      return body.data.find((r) => r.id === runId)?.unread;
    };

    it("is true while the recipient's notification is unread, false after mark", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(true);

      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await app.request(`/api/notifications/${id}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(false);
    });

    it("is per-recipient — A marking read does not clear B's unread flag", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");
      // Actor-less run → one notification each for A (owner) and B (admin).
      const run = await seedNotifiedRun({ agentName: "unread-iso", actor: "schedule" });

      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(true);
      expect(await unreadOf(headersFor(userB), run.id)).toBe(true);

      const aId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await app.request(`/api/notifications/${aId}/read`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(false);
      expect(await unreadOf(headersFor(userB), run.id)).toBe(true);
    });
  });

  // ─── GET /api/runs (org runs, ?user=me filter) — unchanged by #667 ──

  describe("GET /api/runs", () => {
    it("returns empty list when no runs exist", async () => {
      const res = await app.request("/api/runs", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; total: number };
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns all org runs including other members by default", async () => {
      const otherUser = await createTestUser();
      await addOrgMember(ctx.orgId, otherUser.id);
      await seedAgent({ id: "@notiforg/shared-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedRun({
        packageId: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: otherUser.id,
        status: "success",
      });

      const res = await app.request("/api/runs", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; total: number };
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("filters to current user only with ?user=me", async () => {
      const otherUser = await createTestUser();
      await addOrgMember(ctx.orgId, otherUser.id);
      await seedAgent({ id: "@notiforg/filter-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedRun({
        packageId: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: otherUser.id,
        status: "success",
      });

      const res = await app.request("/api/runs?user=me", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { userId: string }[]; total: number };
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.data[0]!.userId).toBe(ctx.user.id);
    });

    it("respects limit + offset", async () => {
      await seedAgent({ id: "@notiforg/page-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      for (let i = 0; i < 5; i++) {
        await seedRun({
          packageId: "@notiforg/page-agent",
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          status: "success",
        });
      }

      const res = await app.request("/api/runs?limit=2&offset=3", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; total: number };
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "isolatedrunorg" });
      await seedAgent({
        id: "@isolatedrunorg/secret-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });
      await seedRun({
        packageId: "@isolatedrunorg/secret-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request("/api/runs", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; total: number };
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs");
      expect(res.status).toBe(401);
    });
  });
});
