// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the `connection_update` SSE channel fan-out in
 * `services/realtime.ts`. Validates the four filter branches added by
 * the connection-renewal-flow PR:
 *
 *   1. application_id mismatch  → skip (cross-app isolation)
 *   2. userId match              → forward (own dashboard rows)
 *   3. userId mismatch           → skip (cross-actor isolation)
 *   4. no actor on subscriber    → skip (anti-leak default)
 *
 * The trigger half (pg_notify emission) is covered by
 * `notify-triggers.test.ts`; this file exercises the LISTEN side.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  addSubscriber,
  removeSubscriber,
  initRealtime,
  type RealtimeEvent,
} from "../../../src/services/realtime.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { createNotifyTriggers } from "@appstrate/db/notify";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { sql } from "drizzle-orm";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const INTEG = "@isoorg/svc";

function buildIntegrationManifest(id: string) {
  return localIntegrationManifest({
    name: id,
    serverName: `${id}-server`,
    version: "1.0.0",
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  });
}

const activeSubscribers: string[] = [];
function trackSubscriber(id: string) {
  activeSubscribers.push(id);
}

describe("realtime — connection_update channel (actor + tenant filter)", () => {
  let ctx: TestContext;
  let ctxOther: TestContext;

  beforeAll(async () => {
    // The trigger is installed on the live test DB so writes here produce
    // real NOTIFY events; the test would be vacuous without it.
    await createNotifyTriggers(db);
    await initRealtime();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "isoorg" });
    ctxOther = await createTestContext({ orgSlug: "isoorg-other" });
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(INTEG),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEG);
  });

  afterEach(() => {
    for (const id of activeSubscribers) removeSubscriber(id);
    activeSubscribers.length = 0;
  });

  /**
   * Helper: insert a connection row for a given owner and wait for the
   * trigger → NOTIFY → LISTEN round-trip to flush.
   */
  async function insertConnection(opts: { userId: string; applicationId: string }) {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEG,
        authKey: "primary",
        accountId: `acct-${opts.userId.slice(0, 6)}`,
        applicationId: opts.applicationId,
        userId: opts.userId,
        endUserId: null,
        credentialsEncrypted: encryptCredentials({ api_key: "v1" }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    await wait(50);
    return row!.id;
  }

  it("forwards connection_update to the owning user's subscriber", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-owner";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        isAdmin: true,
        userId: ctx.user.id,
      },
      send,
    });

    await insertConnection({ userId: ctx.user.id, applicationId: ctx.defaultAppId });

    expect(send).toHaveBeenCalled();
    const evt = send.mock.calls[0]![0]!;
    expect(evt.event).toBe("connection_update");
    expect(evt.data).toMatchObject({
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      integrationPackageId: INTEG,
      operation: "INSERT",
      needsReconnection: false,
    });
  });

  it("skips a subscriber owned by a different user (same application)", async () => {
    // Seed a second member on the SAME app so the cross-actor scenario
    // is meaningful — otherwise the applicationId filter alone would
    // pass/fail the assertion and we wouldn't be exercising the actor
    // filter branch.
    const otherUserId = ctxOther.user.id;
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-other-user";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        isAdmin: true,
        // Subscriber identifies as the OTHER user.
        userId: otherUserId,
      },
      send,
    });

    // Row owned by ctx.user — should NOT reach the other subscriber.
    await insertConnection({ userId: ctx.user.id, applicationId: ctx.defaultAppId });

    expect(send).not.toHaveBeenCalled();
  });

  it("skips a subscriber on a different application (tenant isolation)", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-other-app";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: {
        orgId: ctxOther.orgId,
        applicationId: ctxOther.defaultAppId,
        isAdmin: true,
        userId: ctx.user.id,
      },
      send,
    });

    await insertConnection({ userId: ctx.user.id, applicationId: ctx.defaultAppId });

    expect(send).not.toHaveBeenCalled();
  });

  it("skips a subscriber with no actor identity (anti-leak default)", async () => {
    // Anti-leak guard: a malformed subscriber without userId AND without
    // endUserId must NOT receive connection events, even if the
    // application matches. Regression here would silently fan out every
    // member's connection state.
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-no-actor";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        isAdmin: true,
        // No userId, no endUserId.
      },
      send,
    });

    await insertConnection({ userId: ctx.user.id, applicationId: ctx.defaultAppId });

    expect(send).not.toHaveBeenCalled();
  });

  it("emits UPDATE when needs_reconnection flips, and DELETE on row removal", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-lifecycle";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        isAdmin: true,
        userId: ctx.user.id,
      },
      send,
    });

    const id = await insertConnection({ userId: ctx.user.id, applicationId: ctx.defaultAppId });
    await db.execute(
      sql`UPDATE integration_connections SET needs_reconnection = true WHERE id = ${id}`,
    );
    await wait(50);
    await db.execute(sql`DELETE FROM integration_connections WHERE id = ${id}`);
    await wait(50);

    const ops = send.mock.calls.map((c) => c[0]!.data.operation);
    expect(ops).toContain("INSERT");
    expect(ops).toContain("UPDATE");
    expect(ops).toContain("DELETE");
    const update = send.mock.calls.find((c) => c[0]!.data.operation === "UPDATE")![0]!;
    expect(update.data.needsReconnection).toBe(true);
    const del = send.mock.calls.find((c) => c[0]!.data.operation === "DELETE")![0]!;
    expect(del.data.deleted).toBe(true);
  });
});
