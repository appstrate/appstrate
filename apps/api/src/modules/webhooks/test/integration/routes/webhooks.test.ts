// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedApiKey, seedApplication } from "../../../../../../test/helpers/seed.ts";

const app = getTestApp();

describe("Webhooks API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  function webhookPayload(overrides?: Record<string, unknown>) {
    return {
      level: "application" as const,
      applicationId: ctx.defaultAppId,
      url: "https://example.com/webhook",
      events: ["run.success"],
      ...overrides,
    };
  }

  async function createWebhook(overrides?: Record<string, unknown>) {
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload(overrides)),
    });
    expect(res.status).toBe(201);
    return res.json() as any;
  }

  describe("POST /api/webhooks", () => {
    it("creates a webhook with valid URL and events", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload()),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.url).toBe("https://example.com/webhook");
      expect(body.events).toContain("run.success");
    });

    it("rejects application webhook with invalid applicationId prefix", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "application",
          applicationId: "invalid-no-prefix",
          url: "https://example.com/hook",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("app_");
    });

    it("returns secret only at creation", async () => {
      const body = await createWebhook();
      expect(body.secret).toBeDefined();
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);

      const getRes = await app.request(`/api/webhooks/${body.id}`, {
        headers: authHeaders(ctx),
      });
      expect(getRes.status).toBe(200);
      const detail = (await getRes.json()) as any;
      expect(detail.secret).toBeUndefined();
    });
  });

  describe("GET /api/webhooks", () => {
    it("lists application-level webhooks when applicationId is passed", async () => {
      await createWebhook();
      await createWebhook({ url: "https://example.com/webhook2" });

      const res = await app.request(`/api/webhooks?applicationId=${ctx.defaultAppId}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("lists org-level webhooks when applicationId is omitted", async () => {
      // Create one org-level webhook + one app-level webhook, then list without applicationId.
      await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "org",
          url: "https://example.com/org-webhook",
          events: ["run.success"],
        }),
      });
      await createWebhook();

      const res = await app.request("/api/webhooks", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.length).toBe(1);
      expect(body.data[0].level).toBe("org");
      expect(body.data[0].applicationId).toBeNull();
    });

    it("lists all webhooks in the org when all=true", async () => {
      await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "org",
          url: "https://example.com/org-webhook",
          events: ["run.success"],
        }),
      });
      await createWebhook();

      const res = await app.request("/api/webhooks?all=true", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.length).toBe(2);
    });
  });

  describe("GET /api/webhooks/:id", () => {
    it("returns a single webhook", async () => {
      const created = await createWebhook();

      const res = await app.request(`/api/webhooks/${created.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(created.id);
      expect(body.url).toBe("https://example.com/webhook");
    });
  });

  describe("PUT /api/webhooks/:id", () => {
    it("updates webhook URL", async () => {
      const created = await createWebhook();

      const res = await app.request(`/api/webhooks/${created.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/updated" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.url).toBe("https://example.com/updated");
    });
  });

  describe("DELETE /api/webhooks/:id", () => {
    it("deletes a webhook and returns 204", async () => {
      const created = await createWebhook();

      const res = await app.request(`/api/webhooks/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });
  });

  describe("POST /api/webhooks/:id/rotate", () => {
    it("rotates secret and returns new secret", async () => {
      const created = await createWebhook();

      const res = await app.request(`/api/webhooks/${created.id}/rotate`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.secret).toBeDefined();
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);
    });
  });

  // Issue #172 (extension) — webhook routes filtered by orgId only, so a
  // key bound to App A could read/mutate/rotate App B's webhooks (and
  // org-level webhooks that span every app). The fix funnels API key
  // calls through `applicationIdScope` and forces list/create to the
  // key's bound app.
  describe("API key application scope (issue #172 extension)", () => {
    async function setupCrossAppFixture() {
      const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Webhook Other App" });
      // Org-level webhook (applicationId IS NULL) — created via session.
      const orgWebhookRes = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "org",
          url: "https://example.com/org-hook",
          events: ["run.success"],
        }),
      });
      expect(orgWebhookRes.status).toBe(201);
      const orgWebhook = (await orgWebhookRes.json()) as { id: string };

      // Webhook in the OTHER app — created via session.
      const otherWebhookRes = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "application",
          applicationId: otherApp.id,
          url: "https://example.com/other-hook",
          events: ["run.success"],
        }),
      });
      expect(otherWebhookRes.status).toBe(201);
      const otherWebhook = (await otherWebhookRes.json()) as { id: string };

      // Webhook in the key's OWN app — for control assertions.
      const ownWebhook = await createWebhook();

      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        scopes: ["webhooks:read", "webhooks:write", "webhooks:delete"],
      });
      return {
        otherApp,
        orgWebhookId: orgWebhook.id,
        otherWebhookId: otherWebhook.id,
        ownWebhookId: (ownWebhook as { id: string }).id,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("GET /api/webhooks lists only the key's own app webhooks (no org-level, no other app)", async () => {
      const { ownWebhookId, otherWebhookId, orgWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request("/api/webhooks", { headers: bearer });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((w) => w.id);
      expect(ids).toContain(ownWebhookId);
      expect(ids).not.toContain(otherWebhookId);
      expect(ids).not.toContain(orgWebhookId);
    });

    it("GET /api/webhooks/:otherAppWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, { headers: bearer });
      expect(res.status).toBe(404);
    });

    it("GET /api/webhooks/:orgWebhookId returns 404 (org-level invisible to api key)", async () => {
      const { orgWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${orgWebhookId}`, { headers: bearer });
      expect(res.status).toBe(404);
    });

    it("PUT /api/webhooks/:otherAppWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://attacker.example.com/" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /api/webhooks/:otherAppWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/webhooks/:otherAppWebhookId/rotate returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}/rotate`, {
        method: "POST",
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/webhooks/:otherAppWebhookId/deliveries returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}/deliveries`, {
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/webhooks rejects org-level webhook for API keys", async () => {
      const { bearer } = await setupCrossAppFixture();
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "org",
          url: "https://example.com/pwn",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/webhooks rejects application webhook targeting another app", async () => {
      const { otherApp, bearer } = await setupCrossAppFixture();
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "application",
          applicationId: otherApp.id,
          url: "https://example.com/pwn",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(403);
    });

    it("API key can still operate on its own app webhook (regression guard)", async () => {
      const { ownWebhookId, bearer } = await setupCrossAppFixture();
      const res = await app.request(`/api/webhooks/${ownWebhookId}`, { headers: bearer });
      expect(res.status).toBe(200);
    });
  });
});
