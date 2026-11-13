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
import { seedAgent, seedApiKey, seedRun, seedSpace } from "../../helpers/seed.ts";
import { walkLinkPages } from "../../helpers/pagination.ts";
import Ajv from "ajv";
import { createPackageShareNotification } from "../../../src/services/state/notifications.ts";
import { recordRunFinished } from "../../../src/services/state/run-reads.ts";
import { notificationsPaths } from "../../../src/openapi/paths/notifications.ts";
import { db } from "@appstrate/db/client";
import { notifications } from "@appstrate/db/schema";

const app = getTestApp();

interface NotificationDto {
  id: string;
  type: string;
  runId: string | null;
  payload: {
    packageId?: string;
    package_type?: string;
    shared_by_name?: string;
    status?: string;
  } | null;
  read_at: string | null;
  createdAt: string;
}

// The feed (the dashboard bell) holds every notification of the caller: a
// package share, and a run that failed or timed out. A run's read state is a
// separate `run_reads` row served by the run surfaces — see run-reads.test.ts.

describe("Notifications feed API (per-recipient)", () => {
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

  /** Seed one `package_shared` feed entry for `recipientUserId` (default: ctx.user). */
  async function seedShare(name = "shared", recipientUserId = ctx.user.id): Promise<void> {
    await createPackageShareNotification({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      recipientUserId,
      packageId: `@notiforg/${name}`,
      packageType: "skill",
      sharedByName: "Ada",
    });
  }

  /** Seed an agent + a run, then record it finished (read state, and a bell entry if it failed). */
  async function seedNotifiedRun(
    agentName = "notif-agent",
    status: "success" | "failed" | "timeout" = "success",
  ) {
    const id = `@notiforg/${agentName}`;
    await seedAgent({ id, orgId: ctx.orgId, createdBy: ctx.user.id }).catch(() => {});
    const run = await seedRun({
      packageId: id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      status,
      userId: ctx.user.id,
    });
    await recordRunFinished(scope(), run.id);
    return run;
  }

  async function unreadCount(headers: Record<string, string>): Promise<number> {
    const res = await app.request("/api/notifications/unread-count", { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { count: number }).count;
  }

  async function listNotifications(
    headers: Record<string, string>,
    query = "?unread=true",
  ): Promise<NotificationDto[]> {
    const res = await app.request(`/api/notifications${query}`, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: NotificationDto[] }).data;
  }

  /** `total` of the caller's unread runs. */
  async function unreadRunTotal(): Promise<number> {
    const res = await app.request("/api/runs?unread=true&limit=1", { headers: authHeaders(ctx) });
    return ((await res.json()) as { total: number }).total;
  }

  async function markRead(headers: Record<string, string>, id: string): Promise<number> {
    const res = await app.request(`/api/notifications/${id}/read`, { method: "PUT", headers });
    return res.status;
  }

  // ─── GET /api/notifications ─────────────────────────────────

  describe("GET /api/notifications", () => {
    it("returns the recipient's notifications with payload", async () => {
      await seedShare("pkg-a");

      const data = await listNotifications(authHeaders(ctx));
      expect(data).toHaveLength(1);
      expect(data[0]!.type).toBe("package_shared");
      expect(data[0]!.runId).toBeNull();
      expect(data[0]!.payload?.packageId).toBe("@notiforg/pkg-a");
      expect(data[0]!.payload?.shared_by_name).toBe("Ada");
      expect(data[0]!.read_at).toBeNull();
    });

    it("answers each kind in the shape its OpenAPI branch declares", async () => {
      await seedShare();
      await seedNotifiedRun("branch-agent", "failed");
      const item =
        notificationsPaths["/api/notifications"].get.responses["200"].content["application/json"]
          .schema.properties.data.items;
      const validate = new Ajv({ strict: false, validateFormats: false }).compile(item);

      const data = await listNotifications(authHeaders(ctx));
      expect(data.map((n) => n.type).sort()).toEqual(["package_shared", "run_failed"]);
      for (const n of data)
        expect({ valid: validate(n), errors: validate.errors }).toEqual({
          valid: true,
          errors: null,
        });
      const failed = data.find((n) => n.type === "run_failed")!;
      expect(failed.payload?.status).toBe("failed");
      // The name stamped on the run rides along (null when the run has none).
      expect(failed.payload).toHaveProperty("agent_name");
      // A kind's payload does not validate under the other kind's branch.
      expect(validate({ ...failed, type: "package_shared" })).toBe(false);
      // A succeeded run is not a status the bell carries.
      expect(validate({ ...failed, payload: { ...failed.payload, status: "success" } })).toBe(
        false,
      );
    });

    it("unread=true hides already-read notifications", async () => {
      await seedShare();
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      expect(await markRead(authHeaders(ctx), id)).toBe(204);

      expect(await listNotifications(authHeaders(ctx))).toHaveLength(0);
      // …but still present without the filter.
      const all = await app.request("/api/notifications", { headers: authHeaders(ctx) });
      const allBody = (await all.json()) as {
        object: string;
        data: NotificationDto[];
        hasMore: boolean;
      };
      expect(allBody.object).toBe("list");
      expect(allBody.data).toHaveLength(1);
      expect(allBody.hasMore).toBe(false);
      expect(allBody.data[0]!.id).toBe(id);
    });

    it("lists a failed or timed-out run, and counts it", async () => {
      const failed = await seedNotifiedRun("f-agent", "failed");
      const timedOut = await seedNotifiedRun("t-agent", "timeout");

      const data = await listNotifications(authHeaders(ctx), "");
      expect(data.map((n) => n.runId).sort()).toEqual([failed.id, timedOut.id].sort());
      expect(data.every((n) => n.type === "run_failed")).toBe(true);
      expect(await unreadCount(authHeaders(ctx))).toBe(2);
    });

    it("never lists a successful run, nor counts it", async () => {
      await seedNotifiedRun("ok-agent", "success");
      await seedShare();

      const data = await listNotifications(authHeaders(ctx), "");
      expect(data.map((n) => n.type)).toEqual(["package_shared"]);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("a notification in another org is invisible", async () => {
      await seedShare();
      const otherCtx = await createTestContext({ orgSlug: "othernotiforg" });
      expect(await listNotifications(authHeaders(otherCtx), "")).toHaveLength(0);
      expect(await unreadCount(authHeaders(otherCtx))).toBe(0);
    });

    it("a notification in space A is invisible from space B in the same org", async () => {
      await seedShare();
      const spaceB = await seedSpace({ orgId: ctx.orgId, name: "Space B" });
      const headersB = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": spaceB.id };

      expect(await unreadCount(headersB)).toBe(0);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/notifications");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/notifications/unread-count ────────────────────

  describe("GET /api/notifications/unread-count", () => {
    it("counts the caller's unread feed entries only", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "member");
      await seedShare("one");
      await seedShare("two");
      await seedShare("for-b", userB.id);

      expect(await unreadCount(authHeaders(ctx))).toBe(2);
      expect(await unreadCount(headersFor(userB))).toBe(1);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/notifications/unread-count");
      expect(res.status).toBe(401);
    });
  });

  // ─── PUT /api/notifications/{id}/read ───────────────────────

  describe("PUT /api/notifications/{id}/read", () => {
    it("marks the recipient's notification read (count drops)", async () => {
      await seedShare();
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      expect(await markRead(authHeaders(ctx), id)).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("is idempotent — already-read returns 204", async () => {
      await seedShare();
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      expect(await markRead(authHeaders(ctx), id)).toBe(204);
      expect(await markRead(authHeaders(ctx), id)).toBe(204);
    });

    it("returns 404 for an unknown notification id", async () => {
      expect(await markRead(authHeaders(ctx), "00000000-0000-0000-0000-000000000000")).toBe(404);
    });

    it("returns 404 when a member tries to mark another member's notification (the bug)", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id);

      // A share to user A → only A gets a notification.
      await seedShare();
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      // User B (same org) cannot mark A's notification — 404, not a silent 204.
      expect(await markRead(headersFor(userB), id)).toBe(404);
      // A's notification is untouched.
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("returns 404 for another org's notification", async () => {
      await seedShare();
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      const otherCtx = await createTestContext({ orgSlug: "wrongorg" });
      expect(await markRead(authHeaders(otherCtx), id)).toBe(404);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("returns 404 for another recipient's run notification", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id);
      await seedNotifiedRun("other-fail", "failed");
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      expect(await markRead(headersFor(userB), id)).toBe(404);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("reading a run's notification leaves the run unread", async () => {
      await seedNotifiedRun("stay-unread", "failed");
      const id = (await listNotifications(authHeaders(ctx)))[0]!.id;

      expect(await markRead(authHeaders(ctx), id)).toBe(204);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      expect(await unreadRunTotal()).toBe(1);
    });
  });

  // ─── PUT /api/notifications/read-all ────────────────────────

  describe("PUT /api/notifications/read-all", () => {
    it("marks only the caller's notifications read", async () => {
      const userB = await createTestUser();
      await addOrgMember(ctx.orgId, userB.id, "member");
      await seedShare("mine");
      await seedShare("theirs", userB.id);

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

    it("counts only the still-unread notifications", async () => {
      await seedShare("mix1");
      await seedShare("mix2");
      // Mark one of the two read up front.
      const firstId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await markRead(authHeaders(ctx), firstId);

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      // Only the remaining unread one is flipped.
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("reads a failed run's notification but leaves the run unread", async () => {
      await seedNotifiedRun("fail-all", "failed");
      await seedShare();

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });
      expect(((await res.json()) as { updated_count: number }).updated_count).toBe(2);

      expect(await unreadCount(authHeaders(ctx))).toBe(0);
      expect(await unreadRunTotal()).toBe(1);
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
      await seedShare("p1");
      await seedShare("p2");
      await seedShare("p3");

      const res = await app.request("/api/notifications?limit=2", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: NotificationDto[]; hasMore: boolean };
      expect(body.data).toHaveLength(2);
      expect(body.hasMore).toBe(true);
      // created_at descending (newest first).
      expect(new Date(body.data[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(body.data[1]!.createdAt).getTime(),
      );
      // A further page exists → RFC 5988 next link carrying the keyset cursor.
      expect(nextCursor(res.headers.get("Link"))).toBe(body.data[1]!.id);
    });

    it("walks every page with no skip or duplicate, hasMore flips false at the end", async () => {
      // 5 notifications, paged 2 at a time → pages of [2, 2, 1].
      for (let i = 0; i < 5; i++) await seedShare(`walk-${i}`);

      const pages = await walkLinkPages<{ data: NotificationDto[]; hasMore: boolean }>(
        app,
        "/api/notifications?limit=2",
        authHeaders(ctx),
      );
      expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
      const seen = pages.flatMap((p) => p.data.map((n) => n.id));
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("paginates correctly across rows sharing an identical created_at (tuple tiebreak)", async () => {
      // All five rows get the SAME created_at, so the keyset's (created_at, id)
      // tuple comparison must fall back to the id tiebreak — the entire reason
      // the cursor is a tuple and not a bare timestamp. A timestamp-only cursor
      // would skip or loop here.
      const fixed = new Date("2026-01-01T00:00:00.000Z");
      for (let i = 0; i < 5; i++) {
        await db.insert(notifications).values({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          recipientType: "user",
          recipientId: ctx.user.id,
          type: "package_shared",
          payload: {
            packageId: `@notiforg/tie-${i}`,
            package_type: "skill",
            shared_by_name: "Ada",
          },
          createdAt: fixed,
        });
      }

      const pages = await walkLinkPages<{ data: NotificationDto[] }>(
        app,
        "/api/notifications?limit=2",
        authHeaders(ctx),
      );
      const seen = pages.flatMap((p) => p.data.map((n) => n.id));
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5); // no duplicate, no skip
    });

    it("an unknown/stale startingAfter cursor returns an empty page (not the head)", async () => {
      await seedShare();
      const res = await app.request(
        "/api/notifications?limit=10&startingAfter=00000000-0000-0000-0000-000000000000",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: NotificationDto[]; hasMore: boolean };
      expect(body.data).toHaveLength(0);
      expect(body.hasMore).toBe(false);
    });

    it("hasMore is false on a final page that holds exactly `limit` rows", async () => {
      // 4 rows, limit 2 → pages of [2, 2]; the second page is full yet last.
      // Exercises the limit+1 fetch probe at its boundary (fetch 3, get ≤2).
      for (let i = 0; i < 4; i++) await seedShare(`bound-${i}`);
      const r1 = await app.request("/api/notifications?limit=2", { headers: authHeaders(ctx) });
      const b1 = (await r1.json()) as { data: NotificationDto[]; hasMore: boolean };
      expect(b1.data).toHaveLength(2);
      expect(b1.hasMore).toBe(true);

      const r2 = await app.request(
        `/api/notifications?limit=2&startingAfter=${b1.data.at(-1)!.id}`,
        { headers: authHeaders(ctx) },
      );
      const b2 = (await r2.json()) as { data: NotificationDto[]; hasMore: boolean };
      expect(b2.data).toHaveLength(2);
      expect(b2.hasMore).toBe(false);
      // Cross-page ordering: page 2's first row is older-or-equal to page 1's last.
      expect(new Date(b1.data.at(-1)!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(b2.data[0]!.createdAt).getTime(),
      );
    });

    it("an unread filter paginates independently of read rows", async () => {
      for (let i = 0; i < 3; i++) await seedShare(`uf-${i}`);
      // Mark the newest one read.
      const firstId = (await listNotifications(authHeaders(ctx)))[0]!.id;
      await markRead(authHeaders(ctx), firstId);

      const res = await app.request("/api/notifications?unread=true&limit=2", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { data: NotificationDto[]; hasMore: boolean };
      // 2 unread remain → exactly one page, no more.
      expect(body.data).toHaveLength(2);
      expect(body.hasMore).toBe(false);
      expect(body.data.some((n) => n.id === firstId)).toBe(false);
    });
  });

  // ─── Credential ceiling ─────────────────────────────────────

  describe("credential ceiling", () => {
    // The feed is the caller's own, so no role grant is asked; a delegated
    // credential is capped by the run read.
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
      await seedShare();
      const headers = await keyHeaders(["agents:run"]);
      const res = await app.request("/api/notifications", { headers });
      expect(res.status).toBe(403);
    });

    it("read: a key with runs:read lists the caller's notification", async () => {
      await seedShare();
      expect(await listNotifications(await keyHeaders(["runs:read"]))).toHaveLength(1);
    });

    it("read: a cookie session, which carries no ceiling, lists it", async () => {
      await seedShare();
      expect(await listNotifications(authHeaders(ctx))).toHaveLength(1);
    });

    async function markAll(headers: Record<string, string>): Promise<number> {
      const res = await app.request("/api/notifications/read-all", { method: "PUT", headers });
      return res.status;
    }

    it("write: a key without a run-read scope is refused and nothing is marked", async () => {
      await seedShare();
      expect(await markAll(await keyHeaders(["agents:run"]))).toBe(403);
      expect(await unreadCount(authHeaders(ctx))).toBe(1);
    });

    it("write: a key with runs:read-all marks the caller's notification read", async () => {
      await seedShare();
      expect(await markAll(await keyHeaders(["runs:read-all"]))).toBe(200);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });

    it("write: a cookie session, which carries no ceiling, marks it read", async () => {
      await seedShare();
      expect(await markAll(authHeaders(ctx))).toBe(200);
      expect(await unreadCount(authHeaders(ctx))).toBe(0);
    });
  });
});
