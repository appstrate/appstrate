// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — the inline local server of a `local` integration.
 *
 * A local integration declares its MCP server inline (`source.server`) and ships the payload in
 * its OWN archive, so the spec carries no package id (the sidecar fetches by `integrationId`)
 * and, when the run froze a published version, that version. This suite locks:
 *
 *   - the spec carries `{ type, entry_point }` and `version` only for a run that froze a
 *     published version (system / draft / unfrozen carry none);
 *   - the server's literal `mcp_config.env` reaches `spawnEnv`, `delivery.env` winning on a
 *     name conflict;
 *   - the literal env is a LOCAL-source fact: a remote integration never inherits it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { bindAllConnections } from "../../helpers/bound-connections.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  type LocalServerSpec,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@pinorg/integ";

function integrationManifest(server: LocalServerSpec = {}) {
  return localIntegrationManifest({
    name: INTEG,
    version: "1.2.0",
    server,
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
      },
    },
    tools_policy: { search: {} },
  });
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@pinorg/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

async function seed(ctx: TestContext, server: LocalServerSpec = {}) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: integrationManifest(server),
  });
  await seedSpacePackage(ctx.defaultSpaceId, INTEG);
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "primary",
    accountId: "default",
    label: "default",
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-123" } }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function resolve(
  ctx: TestContext,
  integrationVersions?: Parameters<typeof resolveIntegrationSpawns>[0]["integrationVersions"],
) {
  return (
    await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
      ...(integrationVersions ? { integrationVersions } : {}),
    })
  ).specs;
}

describe("resolveIntegrationSpawns — inline local server", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pinorg" });
  });

  it("carries the entry point and the version the run froze", async () => {
    await seed(ctx, { entryPoint: "server/main.js" });

    const specs = await resolve(ctx, { [INTEG]: { source: "version", version: "1.2.0" } });

    expect(specs).toHaveLength(1);
    expect(specs[0]!.manifest.server).toEqual({
      type: "node",
      entry_point: "server/main.js",
      version: "1.2.0",
    });
  });

  it("carries no version for a draft run, an unfrozen integration or a system one", async () => {
    await seed(ctx);

    for (const frozen of [
      { [INTEG]: { source: "draft" as const, version: null } },
      { [INTEG]: { source: "system" as const, version: null } },
      undefined,
    ]) {
      const specs = await resolve(ctx, frozen);
      expect(specs).toHaveLength(1);
      expect(specs[0]!.manifest.server).toEqual({
        type: "node",
        entry_point: "server/index.js",
      });
    }
  });

  it("merges the server's literal mcp_config.env into spawnEnv, delivery.env winning", async () => {
    await seed(ctx, {
      env: { LOG_LEVEL: "debug", API_KEY: "literal-must-lose", REGION: "ca-central" },
    });

    const specs = await resolve(ctx);

    expect(specs).toHaveLength(1);
    expect(specs[0]!.spawnEnv).toEqual({
      LOG_LEVEL: "debug",
      REGION: "ca-central",
      API_KEY: "secret-123",
    });
  });
});
