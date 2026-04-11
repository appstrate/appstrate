// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { seedPackage } from "../../../../../../test/helpers/seed.ts";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  rotateSecret,
  listDeliveries,
} from "../../../service.ts";
import { webhookDeliveries } from "../../../schema.ts";

describe("webhooks service", () => {
  let userId: string;
  let orgId: string;
  let defaultAppId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId: appId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    defaultAppId = appId;
  });

  function appWebhookParams(overrides?: Record<string, unknown>) {
    return {
      url: "https://example.com/hook",
      events: ["run.success"],
      ...overrides,
    };
  }

  // ── createWebhook ────────────────────────────────────────

  describe("createWebhook", () => {
    it("creates an application-scoped webhook with valid parameters", async () => {
      const wh = await createWebhook(orgId, defaultAppId, appWebhookParams());

      expect(wh.id).toBeDefined();
      expect(wh.id).toStartWith("wh_");
      expect(wh.url).toBe("https://example.com/hook");
      expect(wh.events).toContain("run.success");
      expect(wh.enabled).toBe(true);
      expect(wh.object).toBe("webhook");
      expect(wh.applicationId).toBe(defaultAppId);
    });

    it("creates a webhook with a different URL", async () => {
      const wh = await createWebhook(orgId, defaultAppId, {
        url: "https://example.com/org-hook",
        events: ["run.success"],
      });

      expect(wh.applicationId).toBe(defaultAppId);
    });

    it("returns a secret on creation", async () => {
      const wh = await createWebhook(orgId, defaultAppId, appWebhookParams());

      expect(wh.secret).toBeDefined();
      expect(wh.secret).toStartWith("whsec_");
    });

    it("respects enabled=false override", async () => {
      const wh = await createWebhook(orgId, defaultAppId, appWebhookParams({ enabled: false }));

      expect(wh.enabled).toBe(false);
    });

    it("supports packageId filter", async () => {
      await seedPackage({ id: "@testorg/my-agent", orgId });
      const wh = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ packageId: "@testorg/my-agent" }),
      );

      expect(wh.packageId).toBe("@testorg/my-agent");
    });

    it("supports summary payload mode", async () => {
      const wh = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ payloadMode: "summary" }),
      );

      expect(wh.payloadMode).toBe("summary");
    });

    it("throws for non-HTTPS URLs (when not localhost)", async () => {
      await expect(
        createWebhook(
          orgId,
          defaultAppId,
          appWebhookParams({ url: "http://external-site.com/hook" }),
        ),
      ).rejects.toThrow(/https/i);
    });

    it("can create multiple webhooks for the same org", async () => {
      for (let i = 0; i < 3; i++) {
        await createWebhook(
          orgId,
          defaultAppId,
          appWebhookParams({ url: `https://example.com/hook-${i}` }),
        );
      }
      const all = await listWebhooks(orgId, defaultAppId);
      expect(all).toHaveLength(3);
    });
  });

  // ── listWebhooks ─────────────────────────────────────────

  describe("listWebhooks", () => {
    it("returns all webhooks for an org", async () => {
      await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/hook1" }),
      );
      await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({
          url: "https://example.com/hook2",
          events: ["run.failed"],
        }),
      );

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(2);
    });

    it("filters by applicationId", async () => {
      await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/app-hook" }),
      );

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(1);
      expect(list[0]!.applicationId).toBe(defaultAppId);
    });

    it("does not include webhooks from other orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultAppId: otherAppId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });

      await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/mine" }),
      );
      await createWebhook(otherOrg.id, otherAppId, {
        url: "https://example.com/theirs",
        events: ["run.success"],
      });

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(1);
      expect(list[0]!.url).toBe("https://example.com/mine");
    });

    it("does not expose the secret in list results", async () => {
      await createWebhook(orgId, defaultAppId, appWebhookParams());

      const list = await listWebhooks(orgId, defaultAppId);
      expect((list[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    });
  });

  // ── getWebhook ────────────────────────────────────────────

  describe("getWebhook", () => {
    it("returns a single webhook by ID", async () => {
      const created = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/single" }),
      );

      const wh = await getWebhook(orgId, defaultAppId, created.id);
      expect(wh.id).toBe(created.id);
      expect(wh.url).toBe("https://example.com/single");
    });

    it("throws not found for non-existent webhook", async () => {
      await expect(getWebhook(orgId, defaultAppId, "wh_nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // ── deleteWebhook ─────────────────────────────────────────

  describe("deleteWebhook", () => {
    it("deletes a webhook", async () => {
      const created = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/deleteme" }),
      );

      await deleteWebhook(orgId, defaultAppId, created.id);

      await expect(getWebhook(orgId, defaultAppId, created.id)).rejects.toThrow(/not found/i);
    });
  });

  // ── rotateSecret ──────────────────────────────────────────

  describe("rotateSecret", () => {
    it("returns a new secret different from the original", async () => {
      const created = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/rotate" }),
      );

      const { secret: newSecret } = await rotateSecret(orgId, defaultAppId, created.id);

      expect(newSecret).toBeDefined();
      expect(newSecret).toStartWith("whsec_");
      expect(newSecret).not.toBe(created.secret);
    });
  });

  // ── webhook delivery records ──────────────────────────────

  describe("webhook delivery records", () => {
    it("listDeliveries returns deliveries for a webhook", async () => {
      const created = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/deliveries" }),
      );

      await db.insert(webhookDeliveries).values([
        {
          webhookId: created.id,
          eventId: "evt_test-1",
          eventType: "run.success",
          status: "success",
          statusCode: 200,
          latency: 150,
          attempt: 1,
        },
        {
          webhookId: created.id,
          eventId: "evt_test-2",
          eventType: "run.failed",
          status: "failed",
          statusCode: 500,
          latency: 300,
          attempt: 1,
          error: "Internal Server Error",
        },
      ]);

      const deliveries = await listDeliveries(orgId, defaultAppId, created.id);

      expect(deliveries).toHaveLength(2);
      const statuses = deliveries.map((d) => d.status);
      expect(statuses).toContain("success");
      expect(statuses).toContain("failed");
    });

    it("listDeliveries returns empty array when no deliveries exist", async () => {
      const created = await createWebhook(
        orgId,
        defaultAppId,
        appWebhookParams({ url: "https://example.com/empty-deliveries" }),
      );

      const deliveries = await listDeliveries(orgId, defaultAppId, created.id);
      expect(deliveries).toHaveLength(0);
    });
  });
});
