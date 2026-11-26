// SPDX-License-Identifier: Apache-2.0

/**
 * Contract: webhooks module event handler → delivery pipeline.
 *
 * Verifies the portion of the run → webhook path that is owned by the module:
 * calling the `onRunStatusChange` handler exported by `webhooksModule.events`
 * must enqueue a delivery attempt that lands in `webhook_deliveries`, and must
 * skip webhooks registered for a different event type.
 *
 * The upstream half of the path — core calling `emitEvent("onRunStatusChange")`
 * on every terminal run transition — is covered by
 * `apps/api/test/unit/modules/run-events-contract.test.ts`, and the loader's
 * dispatch from `emitEvent` to all registered module handlers is covered by
 * `apps/api/test/unit/modules/module-loader.test.ts`. Combined, those three
 * tests prove the full cross-module pipeline without requiring this test to
 * spin up the module loader itself (which would duplicate init).
 *
 * This test lives inside the module so disabling webhooks removes it entirely.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../test/helpers/auth.ts";
import webhooksModule from "../../index.ts";
import { createWebhook, initWebhookWorker, shutdownWebhookWorker } from "../../service.ts";
import { webhookDeliveries } from "@appstrate/db/schema";
import { seedPackage, seedSpace } from "../../../../../test/helpers/seed.ts";
import { seedWebhook } from "../helpers/seed.ts";

setDefaultTimeout(30_000);

const WAIT_TIMEOUT_MS = 20_000;

async function waitForDelivery(
  webhookId: string,
  timeoutMs: number,
): Promise<{ eventType: string; status: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ eventType: webhookDeliveries.eventType, status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .limit(1);
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("cross-module contract — onRunStatusChange → webhook delivery", () => {
  let orgId: string;
  let spaceId: string;

  // The preload applies module migrations but does not run `module.init()`,
  // so the delivery worker never starts. Start it explicitly here.
  beforeAll(async () => {
    await initWebhookWorker();
  });

  afterAll(async () => {
    await shutdownWebhookWorker();
  });

  beforeEach(async () => {
    await truncateAll();
    const { id: userId } = await createTestUser();
    const { org, defaultSpaceId } = await createTestOrg(userId, { slug: "cross-mod-test" });
    orgId = org.id;
    spaceId = defaultSpaceId;
  });

  it("the handler persists a webhook_deliveries row for a matching event", async () => {
    // RFC 2606 `.test` TLD is guaranteed never to resolve — the fetch fails
    // fast with a DNS error, but a `webhook_deliveries` row with status="failed"
    // is recorded regardless. That row is what we assert on to prove the
    // cross-module path fired.
    const webhook = await createWebhook({
      level: "space",
      scope: { orgId, spaceId },
      url: "https://no-such-domain-xyz123.test/hook",
      events: ["run.success"],
    });

    // Call the handler the way core's emitEvent would — passing the same
    // RunStatusChangeParams shape that routes/runs.ts emits.
    await webhooksModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_test_1",
      packageId: "@scope/agent",
      spaceId,
      status: "success",
      duration: 1234,
      extra: { result: { ok: true } },
    });

    const row = await waitForDelivery(webhook.id, WAIT_TIMEOUT_MS);
    expect(row).not.toBeNull();
    expect(row?.eventType).toBe("run.success");
  });

  it("does not deliver when the registered event does not match", async () => {
    const webhook = await createWebhook({
      level: "space",
      scope: { orgId, spaceId },
      url: "https://no-such-domain-xyz123.test/hook",
      events: ["run.failed"],
    });

    await webhooksModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_test_2",
      packageId: "@scope/agent",
      spaceId,
      status: "success",
      extra: {},
    });

    // Give the queue a chance to drain — no delivery should appear.
    await new Promise((r) => setTimeout(r, 500));
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhook.id));
    expect(rows).toHaveLength(0);
  });

  it("the onRunConnectionMissing handler persists a run.connection_missing delivery", async () => {
    const webhook = await createWebhook({
      level: "space",
      scope: { orgId, spaceId },
      url: "https://no-such-domain-xyz123.test/hook",
      events: ["run.connection_missing"],
    });

    await webhooksModule.events!.onRunConnectionMissing!({
      orgId,
      spaceId,
      packageId: "@scope/agent",
      actor: { type: "user", id: "u_test" },
      errors: [
        {
          field: "integrations.@official/gmail.api_key",
          code: "missing_integration_connection",
          message: "Connect Gmail to run this agent",
        },
      ],
    });

    const row = await waitForDelivery(webhook.id, WAIT_TIMEOUT_MS);
    expect(row).not.toBeNull();
    expect(row?.eventType).toBe("run.connection_missing");
  });

  describe("onCredentialNeedsReconnection → credential.needs_reconnection", () => {
    const INTEGRATION = "@acme/gmail";
    const connection = (over: { spaceId: string | null }) =>
      ({
        kind: "integration_connection",
        orgId,
        spaceId: over.spaceId,
        connectionId: crypto.randomUUID(),
        packageId: INTEGRATION,
        authKey: "primary",
        owner: { type: "user", id: "u_test" },
        cause: "refresh_token_revoked",
      }) as const;

    /**
     * Webhook ids that received a delivery: waits for each expected one, then reads once more, so a
     * delivery to an unexpected webhook enqueued right behind them still shows.
     */
    async function deliveredTo(all: string[], expected: string[]): Promise<string[]> {
      for (const id of expected) {
        expect((await waitForDelivery(id, WAIT_TIMEOUT_MS))?.eventType).toBe(
          "credential.needs_reconnection",
        );
      }
      await new Promise((r) => setTimeout(r, 100));
      const rows = await db
        .select({ webhookId: webhookDeliveries.webhookId })
        .from(webhookDeliveries);
      const seen = new Set(rows.map((r) => r.webhookId));
      return all.filter((id) => seen.has(id)).sort();
    }

    async function seeds() {
      const other = await seedSpace({ orgId, name: "Other" });
      await seedPackage({ id: INTEGRATION, type: "integration", orgId });
      await seedPackage({ id: "@acme/other", type: "integration", orgId });
      const event = ["credential.needs_reconnection"];
      const mk = (over: { spaceId?: string; packageId?: string }) =>
        seedWebhook({ orgId, events: event, ...over }).then((w) => w.id);
      return {
        org: await mk({}),
        orgForIntegration: await mk({ packageId: INTEGRATION }),
        orgForOther: await mk({ packageId: "@acme/other" }),
        space: await mk({ spaceId }),
        otherSpace: await mk({ spaceId: other.id }),
      };
    }

    it("a space connection reaches its space's and the org-level webhooks, package filter on its integration", async () => {
      const w = await seeds();
      await webhooksModule.events!.onCredentialNeedsReconnection!(connection({ spaceId }));
      const expected = [w.org, w.orgForIntegration, w.space].sort();
      expect(await deliveredTo(Object.values(w), expected)).toEqual(expected);
    });

    it("an org-level connection reaches the org-level webhooks only", async () => {
      const w = await seeds();
      await webhooksModule.events!.onCredentialNeedsReconnection!(connection({ spaceId: null }));
      const expected = [w.org, w.orgForIntegration].sort();
      expect(await deliveredTo(Object.values(w), expected)).toEqual(expected);
    });

    it("a model-provider credential reaches the org-level webhooks without a package filter only", async () => {
      const w = await seeds();
      await webhooksModule.events!.onCredentialNeedsReconnection!({
        kind: "model_provider_credential",
        orgId,
        credentialId: crypto.randomUUID(),
        providerId: "openai",
        cause: "refresh_failures_exhausted",
      });
      expect(await deliveredTo(Object.values(w), [w.org])).toEqual([w.org]);
    });
  });
});
