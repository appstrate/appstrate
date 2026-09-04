// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  authHeaders,
  orgOnlyHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedApiKey, seedSpace } from "../../../../../../test/helpers/seed.ts";

const app = getTestApp();

describe("Webhooks API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  function webhookPayload(overrides?: Record<string, unknown>) {
    return {
      level: "space" as const,
      spaceId: ctx.defaultSpaceId,
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

    /**
     * `spaceId` shape enforcement on this route goes through the same
     * `assertSpaceId` as `X-Space-Id`, so the diagnostics must be the same
     * two: "retired prefix, run the migration" vs "malformed".
     *
     * These assertions pin the CONSTRAINT, not the prefix. `toContain("spc_")`
     * would pass for a rule that only checked the prefix, which is exactly the
     * rule this route must NOT have — the id has to be `spc_` + a canonical
     * UUID, and a `spc_`-prefixed id that isn't one has to be rejected.
     */
    it("rejects a space webhook whose spaceId is not a space id at all", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "space",
          spaceId: "invalid-no-prefix",
          url: "https://example.com/hook",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).toContain("canonical UUID");
      expect(body.param).toBe("spaceId");
    });

    // `spc_` prefix, no canonical UUID. Rejected on shape, not on prefix.
    for (const spaceId of [
      "spc_1",
      "spc_2f1c6d849a524f2bb1a70c9d3e5f7a10",
      "spc_2F1C6D84-9A52-4F2B-B1A7-0C9D3E5F7A10",
      "spc_2f1c6d84-9a52-4f2b-0c9d3e5f7a10",
    ]) {
      it(`rejects the malformed space id '${spaceId}'`, async () => {
        const res = await app.request("/api/webhooks", {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            level: "space",
            spaceId,
            url: "https://example.com/hook",
            events: ["run.success"],
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as any;
        expect(body.detail).toContain("Malformed space id");
        expect(body.detail).not.toContain("retired");
      });
    }

    it("rejects a wrong-prefix spaceId through the same guard as `X-Space-Id`", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "space",
          spaceId: "app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10",
          url: "https://example.com/hook",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.code).toBe("invalid_request");
      expect(body.param).toBe("spaceId");
      // Same diagnostic the `X-Space-Id` path gives — one implementation, and
      // it names no rename: `app_` is simply not a space id shape.
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).not.toContain("retired");
      expect(body.detail).not.toContain("migration");
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
    // The `?spaceId=` filter shares `assertSpaceId` with the create body and
    // with `X-Space-Id` — same shape, same two diagnostics, one implementation.
    it("400s a malformed `?spaceId=` on shape, not on prefix", async () => {
      const res = await app.request("/api/webhooks?spaceId=spc_1", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).toContain("canonical UUID");
      expect(body.param).toBe("spaceId");
    });

    it("400s a wrong-prefix `?spaceId=` on shape", async () => {
      const res = await app.request(
        "/api/webhooks?spaceId=app_2f1c6d84-9a52-4f2b-b1a7-0c9d3e5f7a10",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("Malformed space id");
      expect(body.detail).not.toContain("retired");
      expect(body.detail).not.toContain("migration");
    });

    it("lists space-level webhooks when spaceId is passed", async () => {
      await createWebhook();
      await createWebhook({ url: "https://example.com/webhook2" });

      const res = await app.request(`/api/webhooks?spaceId=${ctx.defaultSpaceId}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("lists org-level webhooks when spaceId is omitted", async () => {
      // Create one org-level webhook + one space-level webhook, then list without spaceId.
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
      expect(body.data[0].spaceId).toBeNull();
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
    it("opens a rotation window and returns both secrets + deadline", async () => {
      const created = await createWebhook();

      const res = await app.request(`/api/webhooks/${created.id}/rotate`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThan(0);
      // Previous secret is exposed so callers can finish in-flight verification.
      expect(typeof body.secretPrevious).toBe("string");
      expect(body.secretPrevious).not.toBe(body.secret);
      // Window deadline is an RFC 3339 timestamp in the future.
      expect(typeof body.rotationWindowEndsAt).toBe("string");
      expect(new Date(body.rotationWindowEndsAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  // Issue #172 (extension) — webhook routes filtered by orgId only, so a
  // key bound to Space A could read/mutate/rotate Space B's webhooks (and
  // org-level webhooks that span every app). The fix funnels API key
  // calls through `spaceIdScope` and forces list/create to the
  // key's bound app.
  /**
   * `level: "org"` webhooks are space-less and their permission is org-level, so
   * managing them must not require a space the caller does not have. The router
   * therefore enters a space only when the caller identifies one.
   */
  describe("a cookie caller with no X-Space-Id", () => {
    const orgPayload = {
      level: "org" as const,
      url: "https://example.com/o",
      events: ["run.success"],
    };

    it("creates, lists and reads an org-level webhook", async () => {
      const created = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(orgPayload),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const listed = await app.request("/api/webhooks", { headers: orgOnlyHeaders(ctx) });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { data: { id: string }[] }).data.map((w) => w.id)).toEqual([
        id,
      ]);

      expect(
        (await app.request(`/api/webhooks/${id}`, { headers: orgOnlyHeaders(ctx) })).status,
      ).toBe(200);
    });

    it("still creates a SPACE-level webhook — the body names the space", async () => {
      // Not a 400: `spaceId` in the body is the space, and the handler enters it
      // explicitly before its guard. Nothing is missing from the request.
      const created = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload()),
      });
      expect(created.status).toBe(201);

      // …and its by-id read works header-less too (the row's own space is
      // re-entered from the row).
      const { id } = (await created.json()) as { id: string };
      expect(
        (await app.request(`/api/webhooks/${id}`, { headers: orgOnlyHeaders(ctx) })).status,
      ).toBe(200);
    });

    it("403s a member, who holds neither half of the split vocabulary", async () => {
      // The control for the owner cases above: the header-less listing is
      // reachable because of the ORG permission, not because the guard is gone.
      const user = await createTestUser();
      await addOrgMember(ctx.orgId, user.id, "member");
      const asMember: TestContext = { ...ctx, user, cookie: user.cookie };
      const denied = await app.request("/api/webhooks", { headers: orgOnlyHeaders(asMember) });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { detail: string }).detail).toContain("org-webhooks:read");
    });
  });

  describe("API key space scope (issue #172 extension)", () => {
    async function setupCrossSpaceFixture() {
      const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Webhook Other Space" });
      // Org-level webhook (spaceId IS NULL) — created via session.
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
          level: "space",
          spaceId: otherSpace.id,
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
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["webhooks:read", "webhooks:write", "webhooks:delete"],
      });
      return {
        otherSpace,
        orgWebhookId: orgWebhook.id,
        otherWebhookId: otherWebhook.id,
        ownWebhookId: (ownWebhook as { id: string }).id,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("GET /api/webhooks lists only the key's own app webhooks (no org-level, no other app)", async () => {
      const { ownWebhookId, otherWebhookId, orgWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request("/api/webhooks", { headers: bearer });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((w) => w.id);
      expect(ids).toContain(ownWebhookId);
      expect(ids).not.toContain(otherWebhookId);
      expect(ids).not.toContain(orgWebhookId);
    });

    it("GET /api/webhooks/:otherSpaceWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, { headers: bearer });
      expect(res.status).toBe(404);
    });

    it("GET /api/webhooks/:orgWebhookId returns 404 (org-level invisible to api key)", async () => {
      const { orgWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${orgWebhookId}`, { headers: bearer });
      expect(res.status).toBe(404);
    });

    it("PUT /api/webhooks/:otherSpaceWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://attacker.example.com/" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /api/webhooks/:otherSpaceWebhookId returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/webhooks/:otherSpaceWebhookId/rotate returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}/rotate`, {
        method: "POST",
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/webhooks/:otherSpaceWebhookId/deliveries returns 404", async () => {
      const { otherWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${otherWebhookId}/deliveries`, {
        headers: bearer,
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/webhooks rejects org-level webhook for API keys", async () => {
      const { bearer } = await setupCrossSpaceFixture();
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

    it("POST /api/webhooks rejects space webhook targeting another app", async () => {
      const { otherSpace, bearer } = await setupCrossSpaceFixture();
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "space",
          spaceId: otherSpace.id,
          url: "https://example.com/pwn",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(403);
    });

    it("API key can still operate on its own app webhook (regression guard)", async () => {
      const { ownWebhookId, bearer } = await setupCrossSpaceFixture();
      const res = await app.request(`/api/webhooks/${ownWebhookId}`, { headers: bearer });
      expect(res.status).toBe(200);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Level-dependent guards: `webhooks` (space) and `org-webhooks` (org) are two
// distinct resources, and every route picks the one the webhook's level
// implies.
// ─────────────────────────────────────────────────────────────────────────

describe("webhooks vs org-webhooks (level-dependent guard)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "levels" });
  });

  async function keyWith(scopes: string[]) {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes,
    });
    return { Authorization: `Bearer ${key.rawKey}` };
  }

  it("either half of the split lets a key list; neither is a 403", async () => {
    // The listing spans both levels, so either half authorises it and the
    // per-row filter decides the contents (asserted per level in
    // `webhooks-level-visibility.test.ts`). A key is additionally narrowed to
    // its own space by `webhookScope`, so the ORG half admits it and yields
    // nothing — that pair is what tells the guard apart from the filter.
    for (const payload of [
      { level: "org", url: "https://example.com/o", events: ["run.success"] },
      {
        level: "space",
        spaceId: ctx.defaultSpaceId,
        url: "https://example.com/s",
        events: ["run.success"],
      },
    ]) {
      const seeded = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(seeded.status).toBe(201);
    }
    const levels = async (headers: Record<string, string>) => {
      const res = await app.request("/api/webhooks?all=true", { headers });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { level: string }[] }).data.map((w) => w.level);
    };

    expect(await levels(await keyWith(["org-webhooks:read"]))).toEqual([]);
    expect(await levels(await keyWith(["webhooks:read"]))).toEqual(["space"]);

    // Neither half: a 403, not an empty page — "you may read nothing here" is
    // not the same answer as "there is nothing here".
    const neither = await keyWith(["runs:read"]);
    expect((await app.request("/api/webhooks", { headers: neither })).status).toBe(403);
  });

  it("creating an org-level webhook needs org-webhooks:write, not webhooks:write", async () => {
    // A key can never create an org-level webhook (it would span foreign
    // spaces), and the permission guard is what refuses it now — before the
    // level check the route already had.
    const spaceOnly = await keyWith(["webhooks:write"]);
    const res = await app.request("/api/webhooks", {
      method: "POST",
      headers: { ...spaceOnly, "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "org",
        url: "https://example.com/org-hook",
        events: ["run.success"],
      }),
    });
    expect(res.status).toBe(403);
  });

  it("an owner session administers both levels end to end", async () => {
    // Control for the two refusals above: the split did not close the routes,
    // it only named who may open them. An owner holds both resources.
    for (const payload of [
      { level: "org", url: "https://example.com/o", events: ["run.success"] },
      {
        level: "space",
        spaceId: ctx.defaultSpaceId,
        url: "https://example.com/s",
        events: ["run.success"],
      },
    ]) {
      const created = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(created.status).toBe(201);
      const { id, level } = (await created.json()) as { id: string; level: string };
      expect(level).toBe(payload.level);

      const read = await app.request(`/api/webhooks/${id}`, { headers: authHeaders(ctx) });
      expect(read.status).toBe(200);

      const updated = await app.request(`/api/webhooks/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(updated.status).toBe(200);

      const deliveries = await app.request(`/api/webhooks/${id}/deliveries`, {
        headers: authHeaders(ctx),
      });
      expect(deliveries.status).toBe(200);

      const removed = await app.request(`/api/webhooks/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(removed.status).toBe(204);
    }
  });
});
