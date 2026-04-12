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
import { webhookDeliveries } from "../../schema.ts";

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
  let applicationId: string;

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
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "cross-mod-test" });
    orgId = org.id;
    applicationId = defaultAppId;
  });

  it("webhooks module exposes an onRunStatusChange handler", () => {
    expect(webhooksModule.events?.onRunStatusChange).toBeDefined();
  });

  it("the handler persists a webhook_deliveries row for a matching event", async () => {
    // RFC 2606 `.test` TLD is guaranteed never to resolve — the fetch fails
    // fast with a DNS error, but a `webhook_deliveries` row with status="failed"
    // is recorded regardless. That row is what we assert on to prove the
    // cross-module path fired.
    const webhook = await createWebhook(orgId, applicationId, {
      url: "https://no-such-domain-xyz123.test/hook",
      events: ["run.success"],
    });

    // Call the handler the way core's emitEvent would — passing the same
    // RunStatusChangeParams shape that routes/runs.ts emits.
    await webhooksModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_test_1",
      packageId: "@scope/agent",
      applicationId,
      status: "success",
      duration: 1234,
      extra: { result: { ok: true } },
    });

    const row = await waitForDelivery(webhook.id, WAIT_TIMEOUT_MS);
    expect(row).not.toBeNull();
    expect(row?.eventType).toBe("run.success");
  });

  it("does not deliver when the registered event does not match", async () => {
    const webhook = await createWebhook(orgId, applicationId, {
      url: "https://no-such-domain-xyz123.test/hook",
      events: ["run.failed"],
    });

    await webhooksModule.events!.onRunStatusChange!({
      orgId,
      runId: "run_test_2",
      packageId: "@scope/agent",
      applicationId,
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
});
