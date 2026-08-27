// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-space resource isolation E2E tests.
 *
 * Verifies that resources created in SpaceA (within the same org)
 * are NOT accessible from SpaceB.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createWebhook,
  createEndUser,
  createApiKey,
  createSpace,
  createSchedule,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

// ═══════════════════════════════════════════════
// Shared setup: 1 org with 2 spaces
// ═══════════════════════════════════════════════

test.describe("Cross-space resource isolation", () => {
  // spaceA = default space (from fixture), spaceB = custom space
  // Agent is installed in both spaces so we can create resources in both contexts

  // ─── Webhooks ──────────────────────────────
  // Webhooks are org-scoped routes (not space-scoped). The `level` field in the
  // request body determines event delivery scope (org vs space), and list
  // filtering uses the `?spaceId=` query param. Individual webhook
  // get/update/delete are accessible to any admin in the org.

  test.describe("Webhook list filtering by space", () => {
    test("Space-level webhook does not appear in another space's filtered list", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-wh-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      // Create space-level webhook scoped to SpaceA (default space)
      const wh = await createWebhook(clientA, {
        level: "space",
        spaceId: orgContext.org.defaultSpaceId,
        url: "https://spaceA.example.com/hook",
      });

      // List filtered by SpaceB — should NOT contain SpaceA's space-level webhook
      const res = await clientB.get(`/webhooks?spaceId=${spaceB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).not.toContain(wh.id);
    });

    test("Space-level webhook does not appear in unfiltered list", async ({
      apiClient: clientA,
      orgContext,
    }) => {
      // Create space-level webhook
      const wh = await createWebhook(clientA, {
        level: "space",
        spaceId: orgContext.org.defaultSpaceId,
      });

      // List without spaceId filter — returns only org-level webhooks
      const res = await clientA.get("/webhooks");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).not.toContain(wh.id);
    });

    test("Space-level webhook appears when listing with correct spaceId", async ({
      apiClient: clientA,
      orgContext,
    }) => {
      const wh = await createWebhook(clientA, {
        level: "space",
        spaceId: orgContext.org.defaultSpaceId,
      });

      const res = await clientA.get(`/webhooks?spaceId=${orgContext.org.defaultSpaceId}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).toContain(wh.id);
    });

    test("Org-level webhook appears in all space-filtered lists", async ({
      apiClient: clientA,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-wh-org-${Date.now()}`);

      const wh = await createWebhook(clientA, {
        level: "org",
        url: "https://org.example.com/hook",
      });

      // Org-level webhooks appear when filtering by any spaceId
      const res = await clientA.get(`/webhooks?spaceId=${spaceB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).toContain(wh.id);
    });
  });

  // ─── End-Users ─────────────────────────────

  test.describe("End-user isolation", () => {
    test("End-users created in SpaceA are not listed from SpaceB", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-eu-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const eu = await createEndUser(clientA, { name: "SpaceA User" });

      // List from SpaceB context — SpaceA's end-user should not appear
      const res = await clientB.get("/end-users");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((e: { id: string }) => e.id);
      expect(ids).not.toContain(eu.id);
    });

    test("SpaceB cannot access SpaceA end-user by ID", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-eu-det-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const eu = await createEndUser(clientA, { name: "SpaceA Detail User" });

      const res = await clientB.get(`/end-users/${eu.id}`);
      expect(res.status()).toBe(404);
    });

    test("SpaceB cannot update SpaceA end-user", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-eu-upd-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const eu = await createEndUser(clientA, { name: "SpaceA Update Target" });

      const res = await clientB.patch(`/end-users/${eu.id}`, { name: "Hijacked" });
      expect(res.status()).toBe(404);
    });

    test("SpaceB cannot delete SpaceA end-user", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-eu-del-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const eu = await createEndUser(clientA, { name: "SpaceA Delete Target" });

      const res = await clientB.delete(`/end-users/${eu.id}`);
      expect(res.status()).toBe(404);
    });
  });

  // ─── Schedules ─────────────────────────────

  test.describe("Schedule isolation", () => {
    test("SpaceB cannot list SpaceA schedules", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-sched-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      // Create an agent in the org catalog (visible from default space)
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-iso-${Date.now()}`;
      await createAgent(clientA, scope, agentName);

      // Create connection profile and schedule in SpaceA
      const schedule = await createSchedule(clientA, scope, agentName);

      // List from SpaceB
      const res = await clientB.get("/schedules");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const schedules = Array.isArray(body) ? body : [];
      const ids = schedules.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(schedule.id);
    });

    test("SpaceB cannot access SpaceA schedule by ID", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-sched-det-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-det-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const schedule = await createSchedule(clientA, scope, agentName);

      const res = await clientB.get(`/schedules/${schedule.id}`);
      expect(res.status()).toBe(404);
    });

    test("SpaceB cannot update SpaceA schedule", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-sched-upd-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-upd-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const schedule = await createSchedule(clientA, scope, agentName);

      const res = await clientB.put(`/schedules/${schedule.id}`, { name: "Hijacked" });
      expect(res.status()).toBe(404);
    });

    test("SpaceB cannot delete SpaceA schedule", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-sched-del-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-del-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const schedule = await createSchedule(clientA, scope, agentName);

      const res = await clientB.delete(`/schedules/${schedule.id}`);
      expect(res.status()).toBe(404);
    });
  });

  // ─── API Keys ──────────────────────────────

  test.describe("API key space-scoping", () => {
    test("API keys created in SpaceA are listed when querying from SpaceA context", async ({
      apiClient: clientA,
    }) => {
      const key = await createApiKey(clientA, `SpaceA Key ${Date.now()}`);

      const res = await clientA.get("/api-keys");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((k: { id: string }) => k.id);
      expect(ids).toContain(key.id);
    });

    test("API keys created in SpaceA are filtered when querying with SpaceB spaceId", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-key-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const key = await createApiKey(clientA, `SpaceA Key ${Date.now()}`);

      const res = await clientB.get(`/api-keys?spaceId=${spaceB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((k: { id: string }) => k.id);
      expect(ids).not.toContain(key.id);
    });
  });

  // ─── Notifications ─────────────────────────

  test.describe("Notification isolation", () => {
    test("Notification counts are independent per space", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-notif-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        spaceId: spaceB.id,
      });

      const resA = await clientA.get("/notifications/unread-count");
      const resB = await clientB.get("/notifications/unread-count");
      expect(resA.status()).toBe(200);
      expect(resB.status()).toBe(200);

      const bodyA = await resA.json();
      const bodyB = await resB.json();
      // Both fresh spaces should start at 0
      expect(bodyA.count).toBe(0);
      expect(bodyB.count).toBe(0);
    });
  });

  // ─── End-user creation scoping ────────────

  test.describe("End-user creation scoping", () => {
    test("POST /end-users rejects spaceId in body", async ({
      apiClient: clientA,
      orgOnlyClient,
    }) => {
      const spaceB = await createSpace(orgOnlyClient, `SpaceB-eu-body-${Date.now()}`);

      // Space scoping is taken from X-Space-Id; body-level spaceId is
      // rejected so clients cannot rely on a silently ignored override.
      const res = await clientA.post("/end-users", {
        name: "Body Override Test",
        spaceId: spaceB.id,
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as {
        code?: string;
        errors?: Array<{ code?: string; message?: string }>;
      };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.some((e) => e.code === "unknown_field")).toBe(true);
    });
  });

  // ─── SSE cookie auth requires spaceId ───────

  test.describe("SSE authentication", () => {
    test("SSE returns 401 without spaceId query param", async ({ request, orgContext }) => {
      const res = await request.get(`/api/realtime/runs?orgId=${orgContext.org.orgId}`, {
        headers: {
          Cookie: orgContext.auth.cookie,
          Accept: "text/event-stream",
        },
      });
      expect(res.status()).toBe(401);
    });
  });
});
