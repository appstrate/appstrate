// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end regression for the prompt-only-agent integration-stripping bug.
 *
 * A prompt-only agent (no skills) that declared integrations used to lose its
 * entire `dependencies.integrations` block when a version was cut from the
 * draft (buildDependencies returned null → the block was deleted). The
 * published manifest then carried only `integrations_configuration`, so at run
 * time `resolveIntegrationSpawns` parsed zero integrations and the agent saw
 * `tool_not_found` for every integration tool.
 *
 * This suite closes the loop the unit tests leave open: it does not just assert
 * the published manifest keeps the data — it feeds the PUBLISHED version's
 * manifest through the exact resolver the run pipeline uses and asserts the
 * integration is spawned with its declared tool in the allowlist.
 *
 * Both tool delivery paths are covered, because the original report
 * (`@tractr/fathom-*`) used `api_call`, which resolves through a different
 * branch (`getApiCallConfigs` / `_meta["dev.appstrate/api"]`) than an MCP-server
 * tool:
 *   - a `source.kind: "local"` integration exposing an MCP tool, and
 *   - a `source.kind: "none"` (serverless) integration exposing `api_call`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { integrationConnections, packageVersions } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  apiIntegrationManifest,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";

const API_KEY_AUTH = {
  primary: {
    type: "api_key" as const,
    authorizedUris: ["https://api.fathom.test/**"],
    credentialFields: ["api_key"],
    delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
  },
};

async function seedConnection(ctx: TestContext, integrationId: string) {
  await db.insert(integrationConnections).values({
    integrationId,
    authKey: "primary",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Seed a prompt-only agent (no skills) declaring `integrationId` with `tool`,
 *  publish it from draft, and return the resolver result against the PUBLISHED
 *  (immutable) version manifest — the exact path the run pipeline uses. */
async function publishAndResolve(
  ctx: TestContext,
  agentId: string,
  integrationId: string,
  tool: string,
) {
  const agent = await seedPackage({
    id: agentId,
    orgId: ctx.orgId,
    type: "agent",
    source: "local",
    draftManifest: {
      schema_version: "0.2",
      type: "agent",
      name: agentId,
      version: "1.0.0",
      display_name: "Prompt Only",
      description: "Prompt-only agent with one integration, zero skills",
      dependencies: { integrations: { [integrationId]: "^1.0.0" } },
      integrations_configuration: { [integrationId]: { tools: [tool], auth_key: "primary" } },
    },
    draftContent: "Do the sync.",
  });

  const result = await createVersionFromDraft({
    packageId: agent.id,
    orgId: ctx.orgId,
    userId: ctx.user.id,
  });
  expect("error" in result).toBe(false);

  const [stored] = await db
    .select({ manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, agentId), eq(packageVersions.version, "1.0.0")))
    .limit(1);

  return resolveIntegrationSpawns({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: stored!.manifest as Record<string, unknown>,
  });
}

describe("publish → resolveIntegrationSpawns (prompt-only agent, e2e)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "e2eorg" });
  });

  it("resolves an MCP-tool integration from the published version manifest", async () => {
    const INTEG = "@e2eorg/mcp-integ";
    const SERVER = "@e2eorg/mcp-integ-server";
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEG,
        version: "1.0.0",
        serverName: SERVER,
        auths: API_KEY_AUTH,
        tools_policy: { search: {} },
      }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: SERVER, version: "1.0.0", serverType: "node" }),
    });
    await seedPackageVersion({
      packageId: SERVER,
      version: "1.0.0",
      manifest: mcpServerManifest({
        name: SERVER,
        version: "1.0.0",
        serverType: "node",
        entryPoint: "./server.js",
      }),
    });
    await seedConnection(ctx, INTEG);

    const specs = await publishAndResolve(ctx, "@e2eorg/agent-mcp", INTEG, "search");

    expect(specs.length).toBe(1);
    expect(specs[0]!.integrationId).toBe(INTEG);
    expect(specs[0]!.sourceKind).toBe("local");
    expect(specs[0]!.toolAllowlist).toEqual(["search"]);
  });

  it("resolves an api_call (serverless) integration — the original Fathom shape", async () => {
    const INTEG = "@e2eorg/fathom";
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: apiIntegrationManifest({
        name: INTEG,
        version: "1.0.0",
        apiCall: { authKey: "primary" },
        auths: API_KEY_AUTH,
      }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedConnection(ctx, INTEG);

    const specs = await publishAndResolve(ctx, "@e2eorg/agent-api", INTEG, "api_call");

    expect(specs.length).toBe(1);
    expect(specs[0]!.integrationId).toBe(INTEG);
    expect(specs[0]!.sourceKind).toBe("none");
    expect(specs[0]!.toolAllowlist).toEqual(["api_call"]);
  });
});
