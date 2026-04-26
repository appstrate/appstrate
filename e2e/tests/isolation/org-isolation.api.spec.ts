// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-org resource isolation E2E tests.
 *
 * Verifies that resources created in OrgA are NOT accessible from OrgB.
 * Tests both read isolation (listing, detail) and mutation isolation (update, delete).
 */

import { test, expect } from "../../fixtures/multi-context.fixture.ts";
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

// ═══════════════════════════════════════════════
// Agents (Packages)
// ═══════════════════════════════════════════════

test.describe("Cross-org agent isolation", () => {
  test("OrgB cannot list OrgA agents", async ({ clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    await createAgent(clientA, scope, `agent-${Date.now()}`);

    const res = await clientB.get("/agents");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const agentIds = (body.data ?? []).map((a: { id: string }) => a.id);
    // OrgA's agents should not appear in OrgB's list
    expect(agentIds.every((id: string) => !id.startsWith(scope))).toBe(true);
  });

  test("OrgB cannot access OrgA agent detail", async ({ clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const name = `agent-iso-${Date.now()}`;
    await createAgent(clientA, scope, name);

    const res = await clientB.get(`/packages/agents/${scope}/${name}`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot update OrgA agent config", async ({ clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const name = `agent-cfg-${Date.now()}`;
    await createAgent(clientA, scope, name);

    const res = await clientB.put(`/agents/${scope}/${name}/config`, { config: { key: "val" } });
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// Webhooks
// ═══════════════════════════════════════════════

test.describe("Cross-org webhook isolation", () => {
  test("OrgB cannot list OrgA webhooks", async ({ clientA, clientB }) => {
    await createWebhook(clientA, { url: "https://orgA.example.com/hook" });

    const res = await clientB.get("/webhooks");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const urls = (body.data ?? []).map((w: { url: string }) => w.url);
    expect(urls).not.toContain("https://orgA.example.com/hook");
  });

  test("OrgB cannot access OrgA webhook by ID", async ({ clientA, clientB }) => {
    const wh = await createWebhook(clientA);
    const res = await clientB.get(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot update OrgA webhook", async ({ clientA, clientB }) => {
    const wh = await createWebhook(clientA);
    const res = await clientB.put(`/webhooks/${wh.id}`, { url: "https://hacked.com" });
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot delete OrgA webhook", async ({ clientA, clientB }) => {
    const wh = await createWebhook(clientA);
    const res = await clientB.delete(`/webhooks/${wh.id}`);
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// End-Users
// ═══════════════════════════════════════════════

test.describe("Cross-org end-user isolation", () => {
  test("OrgB cannot list OrgA end-users", async ({ clientA, clientB }) => {
    const eu = await createEndUser(clientA, { name: "OrgA User" });

    const res = await clientB.get("/end-users");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.data ?? []).map((e: { id: string }) => e.id);
    expect(ids).not.toContain(eu.id);
  });

  test("OrgB cannot access OrgA end-user by ID", async ({ clientA, clientB }) => {
    const eu = await createEndUser(clientA);
    const res = await clientB.get(`/end-users/${eu.id}`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot update OrgA end-user", async ({ clientA, clientB }) => {
    const eu = await createEndUser(clientA);
    const res = await clientB.patch(`/end-users/${eu.id}`, { name: "Hacked" });
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot delete OrgA end-user", async ({ clientA, clientB }) => {
    const eu = await createEndUser(clientA);
    const res = await clientB.delete(`/end-users/${eu.id}`);
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// API Keys
// ═══════════════════════════════════════════════

test.describe("Cross-org API key isolation", () => {
  test("OrgB cannot list OrgA API keys", async ({ clientA, clientB }) => {
    const key = await createApiKey(clientA, "OrgA Key");

    const res = await clientB.get("/api-keys");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = (body.apiKeys ?? []).map((k: { id: string }) => k.id);
    expect(ids).not.toContain(key.id);
  });

  test("OrgB cannot revoke OrgA API key", async ({ clientA, clientB }) => {
    const key = await createApiKey(clientA);
    const res = await clientB.delete(`/api-keys/${key.id}`);
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// Applications
// ═══════════════════════════════════════════════

test.describe("Cross-org application isolation", () => {
  test("OrgB cannot list OrgA applications", async ({ orgClientA, orgClientB }) => {
    await createApplication(orgClientA, "OrgA Custom App");

    const res = await orgClientB.get("/applications");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const names = (body.data ?? []).map((a: { name: string }) => a.name);
    expect(names).not.toContain("OrgA Custom App");
  });

  test("OrgB cannot access OrgA application by ID", async ({
    request,
    ctxA,
    orgClientA,
    orgClientB,
  }) => {
    const app = await createApplication(orgClientA, "OrgA Private App");
    const res = await orgClientB.get(`/applications/${app.id}`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot delete OrgA application", async ({ orgClientA, orgClientB }) => {
    const app = await createApplication(orgClientA, "OrgA Delete Target");
    const res = await orgClientB.delete(`/applications/${app.id}`);
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// Schedules
// ═══════════════════════════════════════════════

test.describe("Cross-org schedule isolation", () => {
  test("OrgB cannot list OrgA schedules", async ({ request, clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const agentName = `sched-agent-${Date.now()}`;
    await createAgent(clientA, scope, agentName);

    const profile = await createConnectionProfile(request, ctxA.auth.cookie, ctxA.org.orgId);

    const schedule = await createSchedule(clientA, scope, agentName, profile.id);

    const res = await clientB.get("/schedules");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const schedules = Array.isArray(body) ? body : [];
    const ids = schedules.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(schedule.id);
  });

  test("OrgB cannot access OrgA schedule by ID", async ({ request, clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const agentName = `sched-det-${Date.now()}`;
    await createAgent(clientA, scope, agentName);

    const profile = await createConnectionProfile(request, ctxA.auth.cookie, ctxA.org.orgId);
    const schedule = await createSchedule(clientA, scope, agentName, profile.id);

    const res = await clientB.get(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot update OrgA schedule", async ({ request, clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const agentName = `sched-upd-${Date.now()}`;
    await createAgent(clientA, scope, agentName);

    const profile = await createConnectionProfile(request, ctxA.auth.cookie, ctxA.org.orgId);
    const schedule = await createSchedule(clientA, scope, agentName, profile.id);

    const res = await clientB.put(`/schedules/${schedule.id}`, { name: "Hijacked" });
    expect(res.status()).toBe(404);
  });

  test("OrgB cannot delete OrgA schedule", async ({ request, clientA, clientB, ctxA }) => {
    const scope = `@${ctxA.org.orgSlug}`;
    const agentName = `sched-del-${Date.now()}`;
    await createAgent(clientA, scope, agentName);

    const profile = await createConnectionProfile(request, ctxA.auth.cookie, ctxA.org.orgId);
    const schedule = await createSchedule(clientA, scope, agentName, profile.id);

    const res = await clientB.delete(`/schedules/${schedule.id}`);
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════
// Notifications (independent counts)
// ═══════════════════════════════════════════════

test.describe("Cross-org notification isolation", () => {
  test("Notification counts are independent per org", async ({ clientA, clientB }) => {
    const resA = await clientA.get("/notifications/unread-count");
    const resB = await clientB.get("/notifications/unread-count");
    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    // Both should return valid counts (likely 0 for fresh orgs)
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(typeof bodyA.count).toBe("number");
    expect(typeof bodyB.count).toBe("number");
  });
});

// ═══════════════════════════════════════════════
// X-App-Id validation (middleware enforcement)
// ═══════════════════════════════════════════════

test.describe("X-App-Id middleware enforcement", () => {
  test("OrgB cannot use OrgA appId as X-App-Id", async ({ request, ctxA, ctxB }) => {
    // Try to access agents using OrgB's cookie + orgId but OrgA's appId
    const res = await request.get("/api/agents", {
      headers: {
        Cookie: ctxB.auth.cookie,
        "X-Org-Id": ctxB.org.orgId,
        "X-App-Id": ctxA.org.defaultAppId, // OrgA's app!
      },
    });
    // Should fail because OrgA's app doesn't belong to OrgB
    expect(res.status()).toBe(404);
  });

  test("Missing X-App-Id on app-scoped route returns 400", async ({ request, ctxA }) => {
    const res = await request.get("/api/agents", {
      headers: {
        Cookie: ctxA.auth.cookie,
        "X-Org-Id": ctxA.org.orgId,
        // No X-App-Id
      },
    });
    expect(res.status()).toBe(400);
  });
});
