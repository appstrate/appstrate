// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Webhooks API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  function webhookPayload(overrides?: Record<string, unknown>) {
    return {
      scope: "application",
      applicationId: ctx.defaultAppId,
      url: "https://example.com/webhook",
      events: ["run.completed"],
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
      expect(body.events).toContain("run.completed");
    });

    it("returns secret only at creation", async () => {
      const body = await createWebhook();
      expect(body.secret).toBeDefined();
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);

      // Get the same webhook — secret should NOT be present
      const getRes = await app.request(`/api/webhooks/${body.id}`, {
        headers: authHeaders(ctx),
      });
      expect(getRes.status).toBe(200);
      const detail = (await getRes.json()) as any;
      expect(detail.secret).toBeUndefined();
    });
  });

  describe("GET /api/webhooks", () => {
    it("lists webhooks", async () => {
      await createWebhook();
      await createWebhook({ url: "https://example.com/webhook2" });

      const res = await app.request("/api/webhooks", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
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
});
