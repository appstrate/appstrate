// SPDX-License-Identifier: Apache-2.0

/**
 * "Make failure legible" — a run that starts WITHOUT an integration its agent
 * declared must say so.
 *
 * The spawn resolver deliberately degrades instead of failing: an agent whose
 * integrations are only partly connected still runs (the pre-flight picker
 * models that explicitly). Before this suite the degradation was invisible —
 * the drop was a server-side `logger.warn` and nothing else, so a run that
 * silently lost half its tools was indistinguishable, from the outside, from
 * an agent that simply never called them.
 *
 * Two halves are covered:
 *   1. `resolveIntegrationSpawns` returns every drop on `dropped[]` with a
 *      machine-readable `reason` (the resolver stays free of DB writes, so it
 *      remains testable without a run row).
 *   2. `recordDroppedIntegrations` turns each entry into ONE `warn` `run_logs`
 *      row — the marker the run page / API reads back. It runs after
 *      `createRun` because `run_logs.run_id` is a hard FK.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { integrationConnections, runLogs } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import {
  resolveIntegrationSpawns,
  type DroppedIntegration,
} from "../../../src/services/integration-spawn-resolver.ts";
import {
  recordDroppedIntegrations,
  INTEGRATION_DROPPED_EVENT,
} from "../../../src/services/run-context-builder.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedInstalledPackage,
  seedPackageVersion,
  seedRun,
} from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@droporg/svc";
const SERVER = "@droporg/svc-server";
const MISSING_SERVER = "@droporg/no-such-server";
const AGENT = "@droporg/agent";

function integManifest(serverName: string): Record<string, unknown> {
  return localIntegrationManifest({
    name: INTEG,
    serverName,
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
    tools_policy: { search: {} },
  }) as unknown as Record<string, unknown>;
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: AGENT,
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

describe("resolveIntegrationSpawns — dropped[] degradation marker", () => {
  let ctx: TestContext;

  async function seedConnection() {
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k-123" } }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
    });
  }

  async function seedServer() {
    const manifest = mcpServerManifest({
      name: SERVER,
      version: "1.0.0",
      serverType: "node",
      entryPoint: "./server.js",
    });
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: manifest,
    });
    await seedPackageVersion({ packageId: SERVER, version: "1.0.0", manifest });
  }

  async function resolve() {
    return resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "droporg" });
  });

  it("reports `not_found` when the declared integration package does not exist", async () => {
    // Nothing seeded at all — the agent declares an integration that is gone.
    const { specs, dropped } = await resolve();

    expect(specs).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.integrationId).toBe(INTEG);
    expect(dropped[0]!.reason).toBe("not_found");
  });

  it("reports `not_installed` when the integration exists but is not installed in the app", async () => {
    await seedServer();
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(SERVER),
    });
    await seedConnection();
    // Deliberately NOT installed in the application.

    const { specs, dropped } = await resolve();

    expect(specs).toHaveLength(0);
    expect(dropped).toEqual([{ integrationId: INTEG, reason: "not_installed" }]);
  });

  it("reports `mcp_server_unresolved` (with a detail) when the referenced server package is missing", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(MISSING_SERVER),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedConnection();

    const { specs, dropped } = await resolve();

    expect(specs).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe("mcp_server_unresolved");
    // The detail names the package the operator has to go install.
    expect(dropped[0]!.detail).toContain(MISSING_SERVER);
  });

  it("reports `no_delivery` when the integration is installed but the actor has no connection", async () => {
    await seedServer();
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(SERVER),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    // No connection seeded.

    const { specs, dropped } = await resolve();

    expect(specs).toHaveLength(0);
    expect(dropped).toEqual([{ integrationId: INTEG, reason: "no_delivery" }]);
  });

  it("leaves `dropped` empty on the happy path", async () => {
    await seedServer();
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(SERVER),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedConnection();

    const { specs, dropped } = await resolve();

    expect(specs).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});

describe("recordDroppedIntegrations — run_logs marker", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "droporg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", source: "local" });
  });

  async function seedPendingRun(): Promise<string> {
    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
    return run.id;
  }

  it("writes ONE warn row per dropped integration, naming the integration and the reason", async () => {
    const runId = await seedPendingRun();
    const dropped: DroppedIntegration[] = [
      { integrationId: INTEG, reason: "not_installed" },
      { integrationId: "@droporg/other", reason: "resolve_error", detail: "boom" },
    ];

    await recordDroppedIntegrations({ orgId: ctx.orgId }, runId, dropped);

    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // `warn` is inside the run_logs CHECK domain, so the row is durable and
      // the UI can style it as a degradation rather than a debug breadcrumb.
      expect(row.level).toBe("warn");
      expect(row.type).toBe("system");
    }

    const first = rows.find((r) => r.data?.integrationId === INTEG);
    expect(first).toBeDefined();
    expect(first!.data!.reason).toBe("not_installed");
    // The message is what an operator reads on the run page — it must name the
    // integration, not just the reason code.
    expect(first!.message).toContain(INTEG);
    expect(first!.message).toContain("not_installed");

    const second = rows.find((r) => r.data?.integrationId === "@droporg/other");
    expect(second).toBeDefined();
    expect(second!.data!.reason).toBe("resolve_error");
    expect(second!.data!.detail).toBe("boom");
    expect(second!.message).toContain("boom");
  });

  it("is a no-op for an empty drop list", async () => {
    const runId = await seedPendingRun();

    await recordDroppedIntegrations({ orgId: ctx.orgId }, runId, []);

    const rows = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(rows).toHaveLength(0);
  });
});
