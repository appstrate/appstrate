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

  function appLevel(overrides?: Record<string, unknown>) {
    return {
      level: "application" as const,
      orgId,
      applicationId: defaultAppId,
      url: "https://example.com/hook",
      events: ["run.success"],
      ...overrides,
    };
  }

  function orgLevel(overrides?: Record<string, unknown>) {
    return {
      level: "org" as const,
      orgId,
      url: "https://example.com/org-hook",
      events: ["run.success"],
      ...overrides,
    };
  }

  // ── createWebhook ────────────────────────────────────────

  describe("createWebhook", () => {
    it("creates an application-level webhook", async () => {
      const wh = await createWebhook(appLevel());

      expect(wh.id).toStartWith("wh_");
      expect(wh.level).toBe("application");
      expect(wh.applicationId).toBe(defaultAppId);
      expect(wh.url).toBe("https://example.com/hook");
      expect(wh.events).toContain("run.success");
      expect(wh.enabled).toBe(true);
    });

    it("creates an org-level webhook with null applicationId", async () => {
      const wh = await createWebhook(orgLevel());

      expect(wh.level).toBe("org");
      expect(wh.applicationId).toBeNull();
    });

    it("returns a secret on creation", async () => {
      const wh = await createWebhook(appLevel());

      expect(wh.secret).toStartWith("whsec_");
    });

    it("respects enabled=false override", async () => {
      const wh = await createWebhook(appLevel({ enabled: false }));
      expect(wh.enabled).toBe(false);
    });

    it("supports packageId filter", async () => {
      await seedPackage({ id: "@testorg/my-agent", orgId });
      const wh = await createWebhook(appLevel({ packageId: "@testorg/my-agent" }));
      expect(wh.packageId).toBe("@testorg/my-agent");
    });

    it("supports summary payload mode", async () => {
      const wh = await createWebhook(appLevel({ payloadMode: "summary" }));
      expect(wh.payloadMode).toBe("summary");
    });

    it("throws for non-HTTPS URLs (when not localhost)", async () => {
      await expect(
        createWebhook(appLevel({ url: "http://external-site.com/hook" })),
      ).rejects.toThrow(/https/i);
    });

    it("can create multiple webhooks for the same application", async () => {
      for (let i = 0; i < 3; i++) {
        await createWebhook(appLevel({ url: `https://example.com/hook-${i}` }));
      }
      const all = await listWebhooks(orgId, defaultAppId);
      // 3 app-level + 0 org-level = 3
      expect(all).toHaveLength(3);
    });
  });

  // ── listWebhooks ─────────────────────────────────────────

  describe("listWebhooks", () => {
    it("returns all app-level webhooks when applicationId is passed", async () => {
      await createWebhook(appLevel({ url: "https://example.com/hook1" }));
      await createWebhook(appLevel({ url: "https://example.com/hook2", events: ["run.failed"] }));

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(2);
    });

    it("merges org-level + app-level when applicationId is passed", async () => {
      await createWebhook(orgLevel({ url: "https://example.com/org" }));
      await createWebhook(appLevel({ url: "https://example.com/app" }));

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(2);
    });

    it("returns only org-level webhooks when applicationId is omitted", async () => {
      await createWebhook(orgLevel({ url: "https://example.com/org" }));
      await createWebhook(appLevel({ url: "https://example.com/app" }));

      const list = await listWebhooks(orgId);
      expect(list).toHaveLength(1);
      expect(list[0]!.level).toBe("org");
      expect(list[0]!.applicationId).toBeNull();
    });

    it("does not include webhooks from other orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultAppId: otherAppId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });

      await createWebhook(appLevel({ url: "https://example.com/mine" }));
      await createWebhook({
        level: "application",
        orgId: otherOrg.id,
        applicationId: otherAppId,
        url: "https://example.com/theirs",
        events: ["run.success"],
      });

      const list = await listWebhooks(orgId, defaultAppId);
      expect(list).toHaveLength(1);
      expect(list[0]!.url).toBe("https://example.com/mine");
    });

    it("does not expose the secret in list results", async () => {
      await createWebhook(appLevel());

      const list = await listWebhooks(orgId, defaultAppId);
      expect((list[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    });
  });

  // ── getWebhook ────────────────────────────────────────────

  describe("getWebhook", () => {
    it("returns a single webhook by ID", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/single" }));

      const wh = await getWebhook(orgId, created.id);
      expect(wh.id).toBe(created.id);
      expect(wh.url).toBe("https://example.com/single");
    });

    it("throws not found for non-existent webhook", async () => {
      await expect(getWebhook(orgId, "wh_nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // ── deleteWebhook ─────────────────────────────────────────

  describe("deleteWebhook", () => {
    it("deletes a webhook", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/deleteme" }));

      await deleteWebhook(orgId, created.id);

      await expect(getWebhook(orgId, created.id)).rejects.toThrow(/not found/i);
    });
  });

  // ── rotateSecret ──────────────────────────────────────────

  describe("rotateSecret", () => {
    it("returns a new secret different from the original", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/rotate" }));

      const { secret: newSecret } = await rotateSecret(orgId, created.id);

      expect(newSecret).toStartWith("whsec_");
      expect(newSecret).not.toBe(created.secret);
    });
  });

  // ── webhook delivery records ──────────────────────────────

  describe("webhook delivery records", () => {
    it("listDeliveries returns deliveries for a webhook", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/deliveries" }));

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

      const deliveries = await listDeliveries(orgId, created.id);

      expect(deliveries).toHaveLength(2);
      const statuses = deliveries.map((d) => d.status);
      expect(statuses).toContain("success");
      expect(statuses).toContain("failed");
    });

    it("listDeliveries returns empty array when no deliveries exist", async () => {
      const created = await createWebhook(
        appLevel({ url: "https://example.com/empty-deliveries" }),
      );

      const deliveries = await listDeliveries(orgId, created.id);
      expect(deliveries).toHaveLength(0);
    });
  });
});
