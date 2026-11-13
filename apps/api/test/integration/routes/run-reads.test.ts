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
import {
  seedAgent,
  seedApiKey,
  seedRun,
  seedEndUser,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { createRunNotifications, markRunRead } from "../../../src/services/state/notifications.ts";
import { deleteEndUser } from "../../../src/services/end-users.ts";
import { removeMember } from "../../../src/services/organizations.ts";
import { synthesiseFinalize } from "../../../src/services/run-event-ingestion.ts";
import { encrypt } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { notifications, runs } from "@appstrate/db/schema";
import { and, eq, sql } from "drizzle-orm";

const app = getTestApp();

// A run's read state is the per-recipient `run_completed` row of the
// `notifications` table. It is read through the run surfaces
// (`GET /api/runs?unread=true`, the `unread` flag, `unread_count` on
// `GET /api/agents`) and written through `PUT /api/runs/{id}/read` and
// `PUT /api/runs/read-all`.

describe("Run read state (per-recipient)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notiforg" });
  });

  const scope = () => ({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });

  /** Headers for an arbitrary user acting within ctx's org/space. */
  function headersFor(user: { cookie: string }): Record<string, string> {
    return {
      Cookie: user.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Space-Id": ctx.defaultSpaceId,
    };
  }

  /**
   * Seed an agent + a run, then run the real fan-out. Returns the run record.
   * `actor` controls the recipient model: own user, an end-user, or none
   * (schedule / actor-less → fan out to org admins/owners).
   */
  async function seedNotifiedRun(opts: {
    agentName?: string;
    actor: { userId: string } | { endUserId: string } | "schedule";
    status?: "success" | "failed";
  }) {
    const agentName = opts.agentName ?? "notif-agent";
    const id = `@notiforg/${agentName}`;
    await seedAgent({ id, orgId: ctx.orgId, createdBy: ctx.user.id }).catch(() => {});
    // Placed and switched on, so the agent index (`GET /api/agents`) lists it.
    await seedSpacePackage(ctx.defaultSpaceId, id);
    const run = await seedRun({
      packageId: id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status: opts.status ?? "success",
      ...(opts.actor === "schedule" ? {} : opts.actor),
    });
    await createRunNotifications(scope(), run.id);
    return run;
  }

  /** The caller's unread run count: the `total` of the unread-filtered run list. */
  async function unreadCount(headers: Record<string, string>): Promise<number> {
    const res = await app.request("/api/runs?unread=true&limit=1", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { total: number }).total;
  }

  /** Ids of the runs the caller has not read yet. */
  async function unreadRunIds(headers: Record<string, string>): Promise<string[]> {
    const res = await app.request("/api/runs?unread=true", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
  }

  async function markRead(headers: Record<string, string>, runId: string): Promise<number> {
    const res = await app.request(`/api/runs/${runId}/read`, { method: "PUT", headers });
    return res.status;
  }

  async function readAll(headers: Record<string, string>): Promise<Response> {
    return app.request("/api/runs/read-all", { method: "PUT", headers });
  }

  /** The `run_completed` rows of one run, straight from the table. */
  async function rowsOf(runId: string) {
    return db
      .select({
        id: notifications.id,
        recipientType: notifications.recipientType,
        recipientId: notifications.recipientId,
        payload: notifications.payload,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(eq(notifications.runId, runId));
  }

  // ─── Fan-out ───────────────────────────────────────────────

  describe("fan-out on finalize", () => {
    it("creates exactly one read-state row for a dashboard-user run", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("end-user run notifies the end-user, not org members", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
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

    it("carries a failed run's status through to the stored payload", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id }, status: "failed" });

      const rows = await rowsOf(run.id);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.payload as { status?: string }).status).toBe("failed");
      expect(await unreadRunIds(authHeaders(ctx))).toEqual([run.id]);
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
        spaceId: ctx.defaultSpaceId,
        status: "success",
        userId: ctx.user.id,
      });

      const [a, b] = await Promise.all([
        createRunNotifications(scope(), run.id),
        createRunNotifications(scope(), run.id),
      ]);
      // Exactly one of the two racers wins the insert; the other no-ops.
      expect(a + b).toBe(1);

      expect(await rowsOf(run.id)).toHaveLength(1);
    });
  });

  // ─── Fan-out through the REAL finalizeRun path ──────────────
  //
  // The tests above call createRunNotifications directly. This one drives the
  // actual terminal-run convergence (synthesiseFinalize → finalizeRun → CAS →
  // broadcast → awaited fan-out) so the wiring at run-event-ingestion.ts — not
  // just the fan-out function — is covered.

  describe("fan-out via finalizeRun", () => {
    async function seedRunningRun(agentName: string) {
      await seedAgent({
        id: `@notiforg/${agentName}`,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      }).catch(() => {});
      const run = await seedRun({
        packageId: `@notiforg/${agentName}`,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        status: "running",
        userId: ctx.user.id,
      });
      // finalizeRun reads a sink context (needs an encrypted sink secret) and
      // applies the zero-token heuristic — seed a non-zero usage so the run
      // stays `success` instead of being flipped to `failed`.
      await db
        .update(runs)
        .set({
          sinkSecretEncrypted: encrypt("test-sink-secret"),
          sinkExpiresAt: new Date(Date.now() + 60_000),
          tokenUsage: { input_tokens: 10, output_tokens: 5 },
        })
        .where(eq(runs.id, run.id));
      return run;
    }

    it("a run finalized through finalizeRun creates exactly one read-state row for its actor", async () => {
      const run = await seedRunningRun("finalize-agent");

      await synthesiseFinalize(run.id, { status: "success" });

      // Run converged terminal via the CAS.
      const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id));
      expect(row!.status).toBe("success");

      // Exactly one row, carrying the run's status, for the actor.
      const rows = await rowsOf(run.id);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.payload as { status?: string }).status).toBe("success");
      expect(await unreadRunIds(authHeaders(ctx))).toEqual([run.id]);
    });

    it("a re-finalize (idempotent CAS) does not create a second row", async () => {
      const run = await seedRunningRun("finalize-twice");

      await synthesiseFinalize(run.id, { status: "success" });
      // Second finalize is a CAS no-op (sink already closed) → no fan-out re-run.
      await synthesiseFinalize(run.id, { status: "success" });

      expect(await rowsOf(run.id)).toHaveLength(1);
    });
  });

  // ─── PUT /api/runs/{id}/read ────────────────────────────────

  describe("PUT /api/runs/{id}/read", () => {
    it("marks the caller's run read (count drops)", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      expect(await markRead(authHeaders(ctx), run.id)).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("is idempotent — a second ack still answers 204", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const h = authHeaders(ctx);

      expect(await markRead(h, run.id)).toBe(204);
      expect(await markRead(h, run.id)).toBe(204);
      expect(await unreadCount(h)).toBe(0);
    });

    it("is an idempotent ack for an unknown run (204, never 404)", async () => {
      expect(await markRead(authHeaders(ctx), "run_does_not_exist")).toBe(204);
    });

    it("is a no-op for a non-recipient (204, owner stays unread)", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "member");
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      expect(await markRead(headersFor(userB), run.id)).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("a member marking another member's run does not touch it (the bug)", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id);

      // A run owned by user A → only A holds read state.
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      // User B (same org) cannot mark A's run — a silent no-op, A stays unread.
      expect(await markRead(headersFor(userB), run.id)).toBe(204);
      expect((await rowsOf(run.id))[0]!.readAt).toBeNull();
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });
  });

  // ─── Per-user read isolation (core of issue #667) ───────────

  describe("per-user read isolation", () => {
    it("A marking a fanned-out run read leaves B's unread", async () => {
      const userB = await createTestUser();
      // Both admins so the actor-less run fans out to each of them.
      await addOrgMember(ctx.orgId, userB.id, "admin");

      // Actor-less run → one row each for A (owner) and B (admin).
      const run = await seedNotifiedRun({ agentName: "iso-agent", actor: "schedule" });
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
      expect(await unreadCount(headersFor(userB))).toBe(1);

      // A marks their own copy read.
      expect(await markRead(authHeaders(ctx), run.id)).toBe(204);

      // A is now read, B is still unread — the bug is fixed.
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      expect(await unreadCount(headersFor(userB))).toBe(1);
    });
  });

  // ─── PUT /api/runs/read-all ─────────────────────────────────

  describe("PUT /api/runs/read-all", () => {
    it("marks only the caller's runs read", async () => {
      const userB = await createTestUser();
      // Admin so the actor-less run fans out to B too.
      await addOrgMember(ctx.orgId, userB.id, "admin");
      await seedNotifiedRun({ agentName: "all-agent", actor: "schedule" });

      const res = await readAll(authHeaders(ctx));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);

      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      // B's copy is untouched.
      expect(await unreadCount(headersFor(userB))).toBe(1);
    });

    it("returns 0 when nothing is unread", async () => {
      const res = await readAll(authHeaders(ctx));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(0);
    });

    it("counts only the still-unread runs", async () => {
      const first = await seedNotifiedRun({ agentName: "mix1", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "mix2", actor: { userId: ctx.user.id } });
      // Mark one of the two read up front.
      await markRead(authHeaders(ctx), first.id);

      const res = await readAll(authHeaders(ctx));
      expect(res.status).toBe(200);
      // Only the remaining unread one is flipped.
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });
  });

  // ─── Per-agent unread counts (`unread_count` on GET /api/agents) ──

  describe("GET /api/agents unread_count", () => {
    async function countsByAgent(headers: Record<string, string>): Promise<Record<string, number>> {
      const res = await app.request("/api/agents", { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; unread_count: number }> };
      return Object.fromEntries(body.data.map((a) => [a.id, a.unread_count]));
    }

    it("groups unread runs by agent id from the payload", async () => {
      await seedNotifiedRun({ agentName: "agent-a", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "agent-a", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "agent-b", actor: { userId: ctx.user.id } });

      const counts = await countsByAgent(authHeaders(ctx));
      expect(counts["@notiforg/agent-a"]).toBe(2);
      expect(counts["@notiforg/agent-b"]).toBe(1);
    });

    it("excludes runs already marked read", async () => {
      const first = await seedNotifiedRun({ agentName: "cba", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "cba", actor: { userId: ctx.user.id } });
      // Mark one of the two read → the unread group must drop to 1.
      await markRead(authHeaders(ctx), first.id);

      const counts = await countsByAgent(authHeaders(ctx));
      expect(counts["@notiforg/cba"]).toBe(1);
    });

    it("is scoped to the caller — another member's unread runs do not count", async () => {
      await seedNotifiedRun({ agentName: "mine", actor: { userId: ctx.user.id } });
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");

      expect((await countsByAgent(headersFor(userB)))["@notiforg/mine"] ?? 0).toBe(0);
    });

    it("skips read-state rows whose payload carries no packageId", async () => {
      await seedNotifiedRun({ agentName: "has-agent", actor: { userId: ctx.user.id } });
      // Hand-insert a row whose agent is gone (`packageId: null`).
      await db.insert(notifications).values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        recipientType: "user",
        recipientId: ctx.user.id,
        type: "run_completed",
        payload: { packageId: null, status: "success" },
      });

      const counts = await countsByAgent(authHeaders(ctx));
      expect(counts["@notiforg/has-agent"]).toBe(1);
      // The null-packageId row is surfaced under no key at all.
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    });

    it("counts run read state only — a share's `packageId` is not a run", async () => {
      await seedNotifiedRun({ agentName: "shared", actor: { userId: ctx.user.id } });
      await db.insert(notifications).values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        recipientType: "user",
        recipientId: ctx.user.id,
        type: "package_shared",
        payload: { packageId: "@notiforg/shared", package_type: "agent", shared_by_name: "A" },
      });

      const counts = await countsByAgent(authHeaders(ctx));
      expect(counts["@notiforg/shared"]).toBe(1);
    });
  });

  // ─── Tenant isolation ───────────────────────────────────────

  describe("org isolation", () => {
    it("a run's read state in another org is invisible", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const otherCtx = await createTestContext({ orgSlug: "othernotiforg" });
      expect(await unreadCount(authHeaders(otherCtx))).toBe(0);
    });

    it("a mark from another org leaves the run unread for its recipient", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });

      const otherCtx = await createTestContext({ orgSlug: "wrongorg" });
      // An idempotent ack: 204, but it reaches no row of another org.
      expect(await markRead(authHeaders(otherCtx), run.id)).toBe(204);
      // Untouched for the real recipient.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });
  });

  describe("cross-space isolation", () => {
    it("a run's read state in space A is invisible from space B in the same org", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } }); // space = ctx.defaultSpaceId
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "Space B" });
      const headersB = {
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": spaceB.id,
      };

      expect(await unreadCount(headersB)).toBe(0);
      // …still visible in space A.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("read-all in space B does not clear space A", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "Space B" });

      const res = await readAll({
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": spaceB.id,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(0);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });
  });

  // ─── createRunNotifications edge cases ──────────────────────

  describe("createRunNotifications edge cases", () => {
    it("returns 0 for an unknown run id and never throws (best-effort contract)", async () => {
      const n = await createRunNotifications(scope(), "run_does_not_exist");
      expect(n).toBe(0);
    });

    it("positively creates exactly one row for the end-user recipient", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "EU positive",
      });
      const run = await seedNotifiedRun({ agentName: "eu-pos", actor: { endUserId: eu.id } });

      const rows = await rowsOf(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipientType).toBe("end_user");
      expect(rows[0]!.recipientId).toBe(eu.id);
    });

    it("creates no row for an inline/ephemeral run (foreground, relayed to trigger)", async () => {
      const inlineId = `@inline/r-${crypto.randomUUID()}`;
      await seedAgent({ id: inlineId, orgId: ctx.orgId, createdBy: ctx.user.id, ephemeral: true });
      const run = await seedRun({
        packageId: inlineId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        status: "success",
        userId: ctx.user.id,
      });

      const n = await createRunNotifications(scope(), run.id);
      expect(n).toBe(0);

      expect(await rowsOf(run.id)).toHaveLength(0);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });
  });

  // ─── end-user recipient mark path (polymorphic actorMatch) ──
  //
  // The recipient filter matches both recipientType and recipientId, so an
  // end-user marks only end-user rows and a dashboard user never matches an
  // end-user row (and vice-versa) — even when the two ids share a value.

  describe("end-user recipient mark path", () => {
    const readAtOf = async (runId: string): Promise<Date | null> =>
      (await rowsOf(runId))[0]!.readAt;

    it("an end-user actor marks their own run read", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "EU mark",
      });
      const run = await seedNotifiedRun({ agentName: "eu-mark", actor: { endUserId: eu.id } });
      expect(await readAtOf(run.id)).toBeNull();

      await markRunRead(scope(), run.id, { type: "end_user", id: eu.id });
      expect(await readAtOf(run.id)).not.toBeNull();
    });

    it("a dashboard user does NOT match an end-user's read-state row", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "EU isolated",
      });
      const run = await seedNotifiedRun({ agentName: "eu-iso", actor: { endUserId: eu.id } });

      // Same id value passed under the wrong actor type must not clear the row.
      await markRunRead(scope(), run.id, { type: "user", id: eu.id });
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
          sql`INSERT INTO notifications (org_id, space_id, recipient_type, type)
              VALUES (${ctx.orgId}, ${ctx.defaultSpaceId}, 'user', 'run_completed')`,
        ),
        "recipient_id",
      );
    });

    it("rejects a row with no recipient_type", async () => {
      await expectNotNullViolation(
        db.execute(
          sql`INSERT INTO notifications (org_id, space_id, recipient_id, type)
              VALUES (${ctx.orgId}, ${ctx.defaultSpaceId}, ${ctx.user.id}, 'run_completed')`,
        ),
        "recipient_type",
      );
    });

    it("rejects an unknown recipient_type via the CHECK (not just the TS union)", async () => {
      let err: unknown;
      try {
        await db.execute(
          sql`INSERT INTO notifications (org_id, space_id, recipient_type, recipient_id, type)
              VALUES (${ctx.orgId}, ${ctx.defaultSpaceId}, 'robot', ${ctx.user.id}, 'run_completed')`,
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
  // user/end-user does not cascade their rows. The deletion sites
  // (deleteEndUser, removeMember) clean them up explicitly — covered here.

  describe("recipient cleanup on deletion", () => {
    const countForRecipient = async (type: "user" | "end_user", id: string): Promise<number> => {
      const rows = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.recipientType, type), eq(notifications.recipientId, id)));
      return rows.length;
    };

    it("deleteEndUser removes the end-user's read-state rows (incl. run-less)", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "EU cleanup",
      });
      // A run-less row: only the explicit cleanup (not the run cascade) can
      // remove this one — proves the delete is real, not incidental to the
      // end-user's runs cascading.
      await db.insert(notifications).values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        recipientType: "end_user",
        recipientId: eu.id,
        type: "run_completed",
        payload: { packageId: null, status: "success" },
      });
      expect(await countForRecipient("end_user", eu.id)).toBe(1);

      await deleteEndUser(scope(), eu.id);
      expect(await countForRecipient("end_user", eu.id)).toBe(0);
    });

    it("removeMember removes the departing member's rows, leaving others", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");
      // Actor-less run → one row each for the owner (A) and admin (B).
      await seedNotifiedRun({ agentName: "cleanup-agent", actor: "schedule" });
      expect(await countForRecipient("user", userB.id)).toBe(1);
      expect(await countForRecipient("user", ctx.user.id)).toBe(1);

      await removeMember(ctx.orgId, userB.id, { userId: ctx.user.id, firstPartySession: true });

      // B's row is gone; A (still a member) keeps theirs.
      expect(await countForRecipient("user", userB.id)).toBe(0);
      expect(await countForRecipient("user", ctx.user.id)).toBe(1);
    });

    it("removeMember leaves end-user rows intact (cleanup is recipient-typed)", async () => {
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        name: "EU survives",
      });
      await seedNotifiedRun({ agentName: "eu-survive", actor: { endUserId: eu.id } });

      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");
      await seedNotifiedRun({ agentName: "member-run", actor: "schedule" });
      expect(await countForRecipient("user", userB.id)).toBe(1);

      await removeMember(ctx.orgId, userB.id, { userId: ctx.user.id, firstPartySession: true });

      // The member's row is cleaned; the end-user (same id-space, different
      // recipientType) is untouched — proves the delete filters on type.
      expect(await countForRecipient("user", userB.id)).toBe(0);
      expect(await countForRecipient("end_user", eu.id)).toBe(1);
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

    it("is true while the recipient's run is unread, false after mark", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(true);

      await markRead(authHeaders(ctx), run.id);
      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(false);
    });

    it("is per-recipient — A marking read does not clear B's unread flag", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "admin");
      // Actor-less run → one row each for A (owner) and B (admin).
      const run = await seedNotifiedRun({ agentName: "unread-iso", actor: "schedule" });

      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(true);
      expect(await unreadOf(headersFor(userB), run.id)).toBe(true);

      await markRead(authHeaders(ctx), run.id);

      expect(await unreadOf(authHeaders(ctx), run.id)).toBe(false);
      expect(await unreadOf(headersFor(userB), run.id)).toBe(true);
    });
  });

  // ─── GET /api/runs?unread= ──────────────────────────────────

  describe("GET /api/runs?unread=", () => {
    it("lists only the runs the caller has not read, `total` is the unread count", async () => {
      const first = await seedNotifiedRun({ agentName: "u1", actor: { userId: ctx.user.id } });
      const second = await seedNotifiedRun({ agentName: "u2", actor: { userId: ctx.user.id } });
      await markRead(authHeaders(ctx), first.id);

      expect(await unreadRunIds(authHeaders(ctx))).toEqual([second.id]);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("unread=false accepts the value and narrows nothing", async () => {
      const read = await seedNotifiedRun({ agentName: "r1", actor: { userId: ctx.user.id } });
      await seedNotifiedRun({ agentName: "r2", actor: { userId: ctx.user.id } });
      await markRead(authHeaders(ctx), read.id);

      const res = await app.request("/api/runs?unread=false", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }>; total: number };
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("refuses any other value with 400", async () => {
      const res = await app.request("/api/runs?unread=maybe", { headers: authHeaders(ctx) });
      expect(res.status).toBe(400);
    });

    it("paginates the unread list (limit + offset) with `total` of every unread run", async () => {
      for (let i = 0; i < 3; i++) {
        await seedNotifiedRun({ agentName: `pg-${i}`, actor: { userId: ctx.user.id } });
      }
      const res = await app.request("/api/runs?unread=true&limit=2&offset=2", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { data: unknown[]; total: number };
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(3);
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
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
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
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
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
          spaceId: ctx.defaultSpaceId,
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
        spaceId: otherCtx.defaultSpaceId,
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

  // ─── Unauthenticated writes ─────────────────────────────────

  describe("authentication", () => {
    it("PUT /api/runs/read-all and /api/runs/{id}/read return 401 without credentials", async () => {
      expect((await app.request("/api/runs/read-all", { method: "PUT" })).status).toBe(401);
      expect((await app.request("/api/runs/run_x/read", { method: "PUT" })).status).toBe(401);
    });
  });

  // ─── Credential ceiling ─────────────────────────────────────
  //
  // A run's read state is capped by the run read: a delegated credential
  // without a run-read scope neither reads nor marks it.

  describe("credential ceiling", () => {
    async function keyHeaders(scopes: string[]): Promise<Record<string, string>> {
      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes,
      });
      return { Authorization: `Bearer ${key.rawKey}` };
    }

    it("read: a key without a run-read scope is refused", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const headers = await keyHeaders(["agents:run"]);
      const res = await app.request("/api/runs?unread=true", { headers });
      expect(res.status).toBe(403);
    });

    it("read: a key with runs:read lists the caller's unread run", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect(await unreadRunIds(await keyHeaders(["runs:read"]))).toEqual([run.id]);
    });

    it("write: a key without a run-read scope is refused and nothing is marked", async () => {
      const run = await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      const headers = await keyHeaders(["agents:run"]);
      expect((await readAll(headers)).status).toBe(403);
      expect(await markRead(headers, run.id)).toBe(403);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("write: a key with runs:read-all marks the caller's run read", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect((await readAll(await keyHeaders(["runs:read-all"]))).status).toBe(200);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("write: a cookie session, which carries no ceiling, marks it read", async () => {
      await seedNotifiedRun({ actor: { userId: ctx.user.id } });
      expect((await readAll(authHeaders(ctx))).status).toBe(200);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });
  });
});
