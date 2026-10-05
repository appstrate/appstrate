// SPDX-License-Identifier: Apache-2.0

import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import { eq } from "drizzle-orm";
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
  dispatchWebhookEvents,
  sendTestPing,
  processDelivery,
  initWebhookWorker,
  shutdownWebhookWorker,
} from "../../../service.ts";
import { webhookDeliveries } from "@appstrate/db/schema";
import { LocalQueue } from "../../../../../infra/queue/local-queue.ts";
import { PermanentJobError } from "../../../../../infra/queue/index.ts";

setDefaultTimeout(30_000);

describe("webhooks service", () => {
  let userId: string;
  let orgId: string;
  let defaultSpaceId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultSpaceId: spaceId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    defaultSpaceId = spaceId;
  });

  function appLevel(overrides?: Record<string, unknown>) {
    return {
      level: "space" as const,
      scope: { orgId, spaceId: defaultSpaceId },
      url: "https://example.com/hook",
      events: ["run.success"],
      ...overrides,
    };
  }

  function orgLevel(overrides?: Record<string, unknown>) {
    return {
      level: "org" as const,
      scope: { orgId },
      url: "https://example.com/org-hook",
      events: ["run.success"],
      ...overrides,
    };
  }

  // ── createWebhook ────────────────────────────────────────

  describe("createWebhook", () => {
    it("creates a space-level webhook", async () => {
      const wh = await createWebhook(appLevel());

      expect(wh.id).toStartWith("wh_");
      expect(wh.level).toBe("space");
      expect(wh.spaceId).toBe(defaultSpaceId);
      expect(wh.url).toBe("https://example.com/hook");
      expect(wh.events).toContain("run.success");
      expect(wh.enabled).toBe(true);
    });

    it("creates an org-level webhook with null spaceId", async () => {
      const wh = await createWebhook(orgLevel());

      expect(wh.level).toBe("org");
      expect(wh.spaceId).toBeNull();
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

    it("can create multiple webhooks for the same space", async () => {
      for (let i = 0; i < 3; i++) {
        await createWebhook(appLevel({ url: `https://example.com/hook-${i}` }));
      }
      const all = await listWebhooks({ orgId }, { spaceId: defaultSpaceId });
      // 3 space-level + 0 org-level = 3
      expect(all).toHaveLength(3);
    });

    it("enforces limit for org-level webhooks independently", async () => {
      // Create 20 org-level webhooks (the max)
      for (let i = 0; i < 20; i++) {
        await createWebhook(orgLevel({ url: `https://example.com/org-hook-${i}` }));
      }
      // 21st should fail
      await expect(
        createWebhook(orgLevel({ url: "https://example.com/org-hook-overflow" })),
      ).rejects.toThrow(/maximum 20 webhooks/i);

      // But a space-level webhook should still be allowed (separate scope)
      const appWh = await createWebhook(appLevel());
      expect(appWh.id).toStartWith("wh_");
    });
  });

  // ── listWebhooks ─────────────────────────────────────────

  describe("listWebhooks", () => {
    it("returns all space-level webhooks when spaceId is passed", async () => {
      await createWebhook(appLevel({ url: "https://example.com/hook1" }));
      await createWebhook(appLevel({ url: "https://example.com/hook2", events: ["run.failed"] }));

      const list = await listWebhooks({ orgId }, { spaceId: defaultSpaceId });
      expect(list).toHaveLength(2);
    });

    it("merges org-level + space-level when spaceId is passed", async () => {
      await createWebhook(orgLevel({ url: "https://example.com/org" }));
      await createWebhook(appLevel({ url: "https://example.com/app" }));

      const list = await listWebhooks({ orgId }, { spaceId: defaultSpaceId });
      expect(list).toHaveLength(2);
    });

    it("returns only org-level webhooks when spaceId is omitted", async () => {
      await createWebhook(orgLevel({ url: "https://example.com/org" }));
      await createWebhook(appLevel({ url: "https://example.com/app" }));

      const list = await listWebhooks({ orgId });
      expect(list).toHaveLength(1);
      expect(list[0]!.level).toBe("org");
      expect(list[0]!.spaceId).toBeNull();
    });

    it("does not include webhooks from other orgs (space-level)", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultSpaceId: otherSpaceId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });

      await createWebhook(appLevel({ url: "https://example.com/mine" }));
      await createWebhook({
        level: "space",
        scope: { orgId: otherOrg.id, spaceId: otherSpaceId },
        url: "https://example.com/theirs",
        events: ["run.success"],
      });

      const list = await listWebhooks({ orgId }, { spaceId: defaultSpaceId });
      expect(list).toHaveLength(1);
      expect(list[0]!.url).toBe("https://example.com/mine");
    });

    it("does not include org-level webhooks from other orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg" });

      await createWebhook(orgLevel({ url: "https://example.com/my-org" }));
      await createWebhook({
        level: "org",
        scope: { orgId: otherOrg.id },
        url: "https://example.com/their-org",
        events: ["run.success"],
      });

      const list = await listWebhooks({ orgId });
      expect(list).toHaveLength(1);
      expect(list[0]!.url).toBe("https://example.com/my-org");
    });

    it("returns all webhooks in the org when all=true", async () => {
      await createWebhook(orgLevel({ url: "https://example.com/org" }));
      await createWebhook(appLevel({ url: "https://example.com/app" }));

      const list = await listWebhooks({ orgId }, { all: true });
      expect(list).toHaveLength(2);
      const levels = list.map((w) => w.level);
      expect(levels).toContain("org");
      expect(levels).toContain("space");
    });

    it("does not expose the secret in list results", async () => {
      await createWebhook(appLevel());

      const list = await listWebhooks({ orgId }, { spaceId: defaultSpaceId });
      expect((list[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    });
  });

  // ── getWebhook ────────────────────────────────────────────

  describe("getWebhook", () => {
    it("returns a single webhook by ID", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/single" }));

      const wh = await getWebhook({ orgId }, created.id);
      expect(wh.id).toBe(created.id);
      expect(wh.url).toBe("https://example.com/single");
    });

    it("throws not found for non-existent webhook", async () => {
      await expect(getWebhook({ orgId }, "wh_nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // ── deleteWebhook ─────────────────────────────────────────

  describe("deleteWebhook", () => {
    it("deletes a webhook", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/deleteme" }));

      await deleteWebhook({ orgId }, created.id);

      await expect(getWebhook({ orgId }, created.id)).rejects.toThrow(/not found/i);
    });
  });

  // ── rotateSecret ──────────────────────────────────────────

  describe("rotateSecret", () => {
    it("opens a dual-signature rotation window", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/rotate" }));

      const result = await rotateSecret({ orgId }, created.id);

      expect(result.secret).toStartWith("whsec_");
      expect(result.secret).not.toBe(created.secret);
      // Previous secret remains valid for the window — consumers verify with it
      // until they migrate to the new one.
      expect(result.secretPrevious).toBe(created.secret);
      // Default 7-day window — sanity check the deadline lands in the future.
      expect(new Date(result.rotationWindowEndsAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("respects an explicit windowSeconds override", async () => {
      const created = await createWebhook(appLevel({ url: "https://example.com/rotate-window" }));

      const result = await rotateSecret({ orgId }, created.id, { windowSeconds: 60 });

      const deadline = new Date(result.rotationWindowEndsAt).getTime();
      // Allow ±5s slack for execution time.
      expect(deadline).toBeGreaterThan(Date.now() + 55_000);
      expect(deadline).toBeLessThan(Date.now() + 65_000);
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

      const { data: deliveries, hasMore } = await listDeliveries({ orgId }, created.id);

      expect(deliveries).toHaveLength(2);
      expect(hasMore).toBe(false);
      const statuses = deliveries.map((d) => d.status);
      expect(statuses).toContain("success");
      expect(statuses).toContain("failed");
    });

    it("listDeliveries returns empty array when no deliveries exist", async () => {
      const created = await createWebhook(
        appLevel({ url: "https://example.com/empty-deliveries" }),
      );

      const { data: deliveries } = await listDeliveries({ orgId }, created.id);
      expect(deliveries).toHaveLength(0);
    });
  });

  // ── dispatchWebhookEvents ────────────────────────────────

  describe("dispatchWebhookEvents", () => {
    // DNS is injected: every host is unresolvable whatever the machine's
    // resolver answers for `.test`, and nothing leaves the process.
    beforeAll(async () => {
      // Replace whatever worker an earlier boot of the module left running.
      await shutdownWebhookWorker();
      await initWebhookWorker({
        resolve: async () => {
          throw new Error("ENOTFOUND (injected)");
        },
      });
    });

    afterAll(async () => {
      await shutdownWebhookWorker();
    });

    async function deliveriesOf(webhookId: string) {
      return db
        .select({
          eventType: webhookDeliveries.eventType,
          status: webhookDeliveries.status,
          attempt: webhookDeliveries.attempt,
          error: webhookDeliveries.error,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, webhookId))
        .orderBy(webhookDeliveries.attempt);
    }

    async function firstDelivery(webhookId: string) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const [row] = await deliveriesOf(webhookId);
        if (row) return row;
        if (Date.now() > deadline) throw new Error("no delivery after 20s");
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("fires org-level webhook for a run in any app of the org", async () => {
      const orgWh = await createWebhook(
        orgLevel({
          url: "https://no-such-domain-xyz123.test/org-hook",
          events: ["run.success"],
        }),
      );

      await dispatchWebhookEvents({ orgId, spaceId: defaultSpaceId }, "run.success", {
        id: "run_dispatch_org",
        packageId: "@scope/agent",
        status: "success",
      });

      expect((await firstDelivery(orgWh.id)).eventType).toBe("run.success");
    });

    it("a DNS miss is retryable on attempts 1 and 2, final from attempt 3", async () => {
      // A miss reached nothing, so it is not the SSRF guard's permanent
      // "blocked address" verdict — but a lapsed domain must not be retried on
      // the full eight-attempt schedule either. The bound is the delivery's
      // attempt number: the processor is called directly with each.
      const wh = await createWebhook(
        appLevel({ url: "https://unresolvable.example/hook", events: ["run.success"] }),
      );
      const attempt = (attemptsMade: number) =>
        processDelivery(
          {
            id: `job_${attemptsMade}`,
            name: "deliver",
            attemptsMade,
            data: { webhookId: wh.id, eventId: "evt_dns", eventType: "run.success", payload: "{}" },
          },
          async () => {
            throw new Error("ENOTFOUND (injected)");
          },
        ).then(
          () => null,
          (err: unknown) => err,
        );

      for (const attemptsMade of [0, 1]) {
        const err = await attempt(attemptsMade);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(PermanentJobError);
      }
      expect(await attempt(2)).toBeInstanceOf(PermanentJobError);

      const rows = await deliveriesOf(wh.id);
      expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
      for (const row of rows) {
        expect(row.status).toBe("failed");
        expect(row.error).toBe("Delivery target hostname could not be resolved");
      }
    });

    it("sendTestPing queues a single-attempt test.ping the webhook is not subscribed to", async () => {
      const wh = await createWebhook(
        appLevel({ url: "https://unresolvable.example/hook", events: ["run.failed"] }),
      );

      // Tier 0 runs the in-memory queue; the per-job option is what keeps a
      // test from being retried for hours, so it is asserted where it is passed.
      const add = spyOn(LocalQueue.prototype, "add");
      try {
        const { eventId, payload } = await sendTestPing(wh);
        expect(payload.type).toBe("test.ping");
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0]).toEqual([
          "deliver",
          expect.objectContaining({ webhookId: wh.id, eventId, eventType: "test.ping" }),
          { attempts: 1 },
        ]);

        const row = await firstDelivery(wh.id);
        expect([row.eventType, row.attempt]).toEqual(["test.ping", 1]);
        const { data } = await listDeliveries({ orgId }, wh.id);
        expect(data.map((d) => d.eventId)).toEqual([eventId]);
      } finally {
        add.mockRestore();
      }
    });
  });
});
