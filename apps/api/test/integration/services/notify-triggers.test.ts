// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: validate that the NOTIFY trigger functions installed by
 * `createNotifyTriggers` reference columns that actually exist on the
 * `runs` / `run_logs` tables.
 *
 * Pre-existing realtime tests fire `pg_notify(...)` directly via
 * `db.execute()` — they never exercise the trigger function body, so a
 * dangling column reference (e.g. `NEW.user_id` after the column is
 * split/renamed) is invisible to them and only surfaces at runtime on the
 * first real INSERT/UPDATE.
 *
 * These tests install the triggers, then perform a real INSERT + UPDATE on
 * `runs` (and INSERT on `run_logs`) to force Postgres to evaluate the
 * trigger function bodies against the current schema.
 */

import { describe, it, beforeAll, afterAll, beforeEach, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../../helpers/db.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { listenClient } from "@appstrate/db/client";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { integrationConnections } from "@appstrate/db/schema";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedRunLog, seedPackage } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

describe("NOTIFY triggers (regression)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await createNotifyTriggers(db);
  });

  // Drop the triggers we installed so they do not leak to other test files.
  // The full suite (`bun test`) runs every file in a single Bun process; without
  // this teardown, run-metric-broadcaster + run-metric-streaming + persisting-event-sink
  // see runs_notify_trigger firing on every UPDATE the broadcaster issues to
  // persist `cost`, deliver an extra `run_update` event to their subscribers,
  // and trip `toHaveBeenCalledTimes(N)` assertions by one. The leak is order-
  // sensitive (Bun's per-file ordering is not strict alphabetical) which is
  // why CI flaked while local runs sometimes passed.
  afterAll(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS runs_notify_trigger ON runs`);
    await db.execute(sql`DROP TRIGGER IF EXISTS run_logs_notify_trigger ON run_logs`);
    // Connection trigger drives the connectors-page live badge; drop it too
    // so it does not leak into other suites that fire integration_connections
    // writes and would receive extra NOTIFY events.
    await db.execute(
      sql`DROP TRIGGER IF EXISTS integration_connections_notify_trigger ON integration_connections`,
    );
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notifyorg" });
    await seedAgent({
      id: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
  });

  it("notify_run_change fires on INSERT without referencing removed columns", async () => {
    // Must not throw: `record "new" has no field "user_id"` if trigger is stale.
    await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "pending",
    });
  });

  it("notify_run_change fires on UPDATE", async () => {
    const run = await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "pending",
    });
    // A status transition is what production hits on every run lifecycle step.
    await db.execute(
      (await import("drizzle-orm")).sql`UPDATE runs SET status = 'running' WHERE id = ${run.id}`,
    );
  });

  it("notify_run_log_insert fires on run_logs INSERT", async () => {
    const run = await seedRun({
      packageId: "@notifyorg/trigger-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    await seedRunLog({
      runId: run.id,
      orgId: ctx.orgId,
      level: "info",
      message: "trigger smoke test",
    });
  });

  // Drives the live "Reconnection required" badge end-to-end: trigger →
  // pg_notify → LISTEN → SSE event. The actor filter on the realtime
  // subscriber is exercised separately in services/realtime tests; here we
  // only assert that the trigger body fires + emits the contract payload.
  it("notify_integration_connection_change fires on INSERT + UPDATE + DELETE", async () => {
    const INTEG = "@notifyorg/svc";
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEG,
        serverName: "@notifyorg/svc-server",
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
      }),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEG);

    // Local accumulator — the listener handler stays attached for the
    // process lifetime (the ListenClient abstraction in db/client.ts hides
    // postgres.js's unlisten by casting to Promise<void>). `afterAll` drops
    // the trigger so no more NOTIFYs fire on integration_connections, and
    // the application_id filter inside the handler scopes to this test only.
    const received: Array<{ operation: string; needs_reconnection: boolean | null }> = [];
    await listenClient.listen("connection_update", (raw) => {
      try {
        const payload = JSON.parse(raw) as {
          operation: string;
          application_id: string;
          needs_reconnection: boolean | null;
        };
        if (payload.application_id !== ctx.defaultAppId) return;
        received.push({
          operation: payload.operation,
          needs_reconnection: payload.needs_reconnection,
        });
      } catch {
        /* ignore */
      }
    });

    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEG,
        authKey: "primary",
        accountId: `acct-${ctx.user.id.slice(0, 6)}`,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "v1" } }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    const connId = row!.id;

    await db.execute(
      sql`UPDATE integration_connections SET needs_reconnection = true WHERE id = ${connId}`,
    );
    await db.execute(sql`DELETE FROM integration_connections WHERE id = ${connId}`);

    // NOTIFY is async w.r.t. the trigger fire — give the listener a tick.
    for (let i = 0; i < 20 && received.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const ops = received.map((r) => r.operation);
    expect(ops).toContain("INSERT");
    expect(ops).toContain("UPDATE");
    expect(ops).toContain("DELETE");
    // INSERT defaults to needs_reconnection=false; UPDATE flips it true;
    // DELETE carries NULL by trigger contract.
    const insert = received.find((r) => r.operation === "INSERT");
    const update = received.find((r) => r.operation === "UPDATE");
    const del = received.find((r) => r.operation === "DELETE");
    expect(insert?.needs_reconnection).toBe(false);
    expect(update?.needs_reconnection).toBe(true);
    expect(del?.needs_reconnection).toBeNull();
  });
});
