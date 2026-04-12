// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app resource isolation E2E tests.
 *
 * Verifies that resources created in AppA (within the same org)
 * are NOT accessible from AppB.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import {
  createAgent,
  createWebhook,
  createEndUser,
  createApiKey,
  createApplication,
  createConnectionProfile,
  createSchedule,
  installPackageInApp,
} from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

// ═══════════════════════════════════════════════
// Shared setup: 1 org with 2 apps
// ═══════════════════════════════════════════════

test.describe("Cross-app resource isolation", () => {
  // appA = default app (from fixture), appB = custom app
  // Agent is installed in both apps so we can create resources in both contexts

  // ─── Webhooks ──────────────────────────────
  // Webhooks are org-scoped routes (not app-scoped). The `level` field in the
  // request body determines event delivery scope (org vs application), and list
  // filtering uses the `?applicationId=` query param. Individual webhook
  // get/update/delete are accessible to any admin in the org.

  test.describe("Webhook list filtering by application", () => {
    test("App-level webhook does not appear in another app's filtered list", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-wh-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      // Create app-level webhook scoped to AppA (default app)
      const wh = await createWebhook(clientA, {
        level: "application",
        applicationId: orgContext.org.defaultAppId,
        url: "https://appA.example.com/hook",
      });

      // List filtered by AppB — should NOT contain AppA's app-level webhook
      const res = await clientB.get(`/webhooks?applicationId=${appB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).not.toContain(wh.id);
    });

    test("App-level webhook does not appear in unfiltered list", async ({
      apiClient: clientA,
      orgContext,
    }) => {
      // Create app-level webhook
      const wh = await createWebhook(clientA, {
        level: "application",
        applicationId: orgContext.org.defaultAppId,
      });

      // List without applicationId filter — returns only org-level webhooks
      const res = await clientA.get("/webhooks");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).not.toContain(wh.id);
    });

    test("App-level webhook appears when listing with correct applicationId", async ({
      apiClient: clientA,
      orgContext,
    }) => {
      const wh = await createWebhook(clientA, {
        level: "application",
        applicationId: orgContext.org.defaultAppId,
      });

      const res = await clientA.get(`/webhooks?applicationId=${orgContext.org.defaultAppId}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).toContain(wh.id);
    });

    test("Org-level webhook appears in all application-filtered lists", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-wh-org-${Date.now()}`);

      const wh = await createWebhook(clientA, {
        level: "org",
        url: "https://org.example.com/hook",
      });

      // Org-level webhooks appear when filtering by any applicationId
      const res = await clientA.get(`/webhooks?applicationId=${appB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((w: { id: string }) => w.id);
      expect(ids).toContain(wh.id);
    });
  });

  // ─── End-Users ─────────────────────────────

  test.describe("End-user isolation", () => {
    test("End-users created in AppA are not listed from AppB", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-eu-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const eu = await createEndUser(clientA, { name: "AppA User" });

      // List from AppB context — AppA's end-user should not appear
      const res = await clientB.get("/end-users");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.data ?? []).map((e: { id: string }) => e.id);
      expect(ids).not.toContain(eu.id);
    });

    test("AppB cannot access AppA end-user by ID", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-eu-det-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const eu = await createEndUser(clientA, { name: "AppA Detail User" });

      const res = await clientB.get(`/end-users/${eu.id}`);
      expect(res.status()).toBe(404);
    });

    test("AppB cannot update AppA end-user", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-eu-upd-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const eu = await createEndUser(clientA, { name: "AppA Update Target" });

      const res = await clientB.patch(`/end-users/${eu.id}`, { name: "Hijacked" });
      expect(res.status()).toBe(404);
    });

    test("AppB cannot delete AppA end-user", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-eu-del-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const eu = await createEndUser(clientA, { name: "AppA Delete Target" });

      const res = await clientB.delete(`/end-users/${eu.id}`);
      expect(res.status()).toBe(404);
    });
  });

  // ─── Schedules ─────────────────────────────

  test.describe("Schedule isolation", () => {
    test("AppB cannot list AppA schedules", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-sched-list-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      // Create an agent in the org catalog (visible from default app)
      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-iso-${Date.now()}`;
      await createAgent(clientA, scope, agentName);

      // Create connection profile and schedule in AppA
      const profile = await createConnectionProfile(
        request,
        orgContext.auth.cookie,
        orgContext.org.orgId,
      );
      const schedule = await createSchedule(clientA, scope, agentName, profile.id);

      // List from AppB
      const res = await clientB.get("/schedules");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const schedules = Array.isArray(body) ? body : [];
      const ids = schedules.map((s: { id: string }) => s.id);
      expect(ids).not.toContain(schedule.id);
    });

    test("AppB cannot access AppA schedule by ID", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-sched-det-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-det-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const profile = await createConnectionProfile(
        request,
        orgContext.auth.cookie,
        orgContext.org.orgId,
      );
      const schedule = await createSchedule(clientA, scope, agentName, profile.id);

      const res = await clientB.get(`/schedules/${schedule.id}`);
      expect(res.status()).toBe(404);
    });

    test("AppB cannot update AppA schedule", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-sched-upd-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-upd-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const profile = await createConnectionProfile(
        request,
        orgContext.auth.cookie,
        orgContext.org.orgId,
      );
      const schedule = await createSchedule(clientA, scope, agentName, profile.id);

      const res = await clientB.put(`/schedules/${schedule.id}`, { name: "Hijacked" });
      expect(res.status()).toBe(404);
    });

    test("AppB cannot delete AppA schedule", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-sched-del-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const scope = `@${orgContext.org.orgSlug}`;
      const agentName = `sched-del-${Date.now()}`;
      await createAgent(clientA, scope, agentName);
      const profile = await createConnectionProfile(
        request,
        orgContext.auth.cookie,
        orgContext.org.orgId,
      );
      const schedule = await createSchedule(clientA, scope, agentName, profile.id);

      const res = await clientB.delete(`/schedules/${schedule.id}`);
      expect(res.status()).toBe(404);
    });
  });

  // ─── API Keys ──────────────────────────────

  test.describe("API key app-scoping", () => {
    test("API keys created in AppA are listed when querying from AppA context", async ({
      apiClient: clientA,
    }) => {
      const key = await createApiKey(clientA, `AppA Key ${Date.now()}`);

      const res = await clientA.get("/api-keys");
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.apiKeys ?? []).map((k: { id: string }) => k.id);
      expect(ids).toContain(key.id);
    });

    test("API keys created in AppA are filtered when querying with AppB applicationId", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-key-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const key = await createApiKey(clientA, `AppA Key ${Date.now()}`);

      const res = await clientB.get(`/api-keys?applicationId=${appB.id}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const ids = (body.apiKeys ?? []).map((k: { id: string }) => k.id);
      expect(ids).not.toContain(key.id);
    });
  });

  // ─── Notifications ─────────────────────────

  test.describe("Notification isolation", () => {
    test("Notification counts are independent per app", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-notif-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      const resA = await clientA.get("/notifications/unread-count");
      const resB = await clientB.get("/notifications/unread-count");
      expect(resA.status()).toBe(200);
      expect(resB.status()).toBe(200);

      const bodyA = await resA.json();
      const bodyB = await resB.json();
      // Both fresh apps should start at 0
      expect(bodyA.count).toBe(0);
      expect(bodyB.count).toBe(0);
    });
  });

  // ─── End-user creation scoping ────────────

  test.describe("End-user creation scoping", () => {
    test("POST /end-users ignores applicationId in body — always uses X-App-Id", async ({
      request,
      apiClient: clientA,
      orgContext,
      orgOnlyClient,
    }) => {
      const appB = await createApplication(orgOnlyClient, `AppB-eu-body-${Date.now()}`);
      const clientB = createApiClient(request, {
        cookie: orgContext.auth.cookie,
        orgId: orgContext.org.orgId,
        appId: appB.id,
      });

      // Create end-user from AppA context, but sneak appB's ID in the body
      const res = await clientA.post("/end-users", {
        name: "Body Override Test",
        applicationId: appB.id,
      });
      expect(res.status()).toBe(201);
      const eu = await res.json();

      // The end-user should belong to AppA (the X-App-Id), not AppB
      const resA = await clientA.get(`/end-users/${eu.id}`);
      expect(resA.status()).toBe(200);

      // AppB should NOT see this end-user
      const resB = await clientB.get(`/end-users/${eu.id}`);
      expect(resB.status()).toBe(404);
    });
  });

  // ─── SSE cookie auth requires appId ───────

  test.describe("SSE authentication", () => {
    test("SSE returns 401 without appId query param", async ({ request, orgContext }) => {
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
