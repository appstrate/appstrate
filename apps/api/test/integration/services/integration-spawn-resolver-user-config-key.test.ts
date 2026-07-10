// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `delivery.env.<var>.user_config_key` binding (AFPS
 * §7.6, CC-4).
 *
 * The integration's `delivery.env.<var>` carries a `user_config_key` that names
 * a placeholder (`${user_config.<key>}`) in the referenced mcp-server's
 * `server.mcp_config.env` template. The resolver pre-renders the substitution
 * so the same package works in BOTH Appstrate's local-source runtime AND a
 * standalone MCPB host.
 *
 * Verifies:
 *  - Explicit `user_config_key` substitutes the named placeholder in
 *    `mcp_config.env` and the rendered key flows into `spawnEnv`.
 *  - Omitting `user_config_key` defaults to the env-variable name itself
 *    (spec note: "consumers SHOULD default to the env-variable name").
 *  - The integration's direct `delivery.env` key wins on conflict with the
 *    mcp-server's `mcp_config.env` key (integration is authoritative).
 *  - Unresolved placeholders pass through unchanged (operator visibility).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
  envDeliveryWithUserConfigKey,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/uc-integ";
const SERVER = "@orga/uc-server";

interface SeedOpts {
  envEntries: Record<string, { field: string; userConfigKey?: string }>;
  mcpConfigEnv: Record<string, string>;
}

async function seedAll(ctx: TestContext, opts: SeedOpts, credBag: Record<string, string>) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: localIntegrationManifest({
      name: INTEG,
      serverName: SERVER,
      version: "0.1.0",
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/**"],
          credentialFields: Object.keys(credBag),
          delivery: envDeliveryWithUserConfigKey(opts.envEntries),
        },
      },
      tools_policy: { call: {} },
    }),
  });
  await seedInstalledPackage(ctx.defaultAppId, INTEG);
  const serverManifest = mcpServerManifest({
    name: SERVER,
    version: "0.1.0",
    serverType: "node",
    entryPoint: "./server.js",
    mcpConfigEnv: opts.mcpConfigEnv,
  });
  await seedPackage({
    id: SERVER,
    orgId: ctx.orgId,
    type: "mcp-server",
    source: "local",
    draftManifest: serverManifest,
  });
  await seedPackageVersion({ packageId: SERVER, version: "0.1.0", manifest: serverManifest });
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "primary",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: credBag }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^0.1.0" } },
    integrations_configuration: { [INTEG]: { tools: ["call"] } },
  };
}

describe("resolveIntegrationSpawns — delivery.env.user_config_key (CC-4)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("substitutes ${user_config.<key>} in mcp_config.env using the explicit user_config_key", async () => {
    await seedAll(
      ctx,
      {
        envEntries: { MY_TOKEN: { field: "api_key", userConfigKey: "API_KEY" } },
        // The mcp-server declares a placeholder under a DIFFERENT key name —
        // the bridge needs the explicit `user_config_key` to find it.
        mcpConfigEnv: { SOMETHING: "${user_config.API_KEY}" },
      },
      { api_key: "secret-123" },
    );

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const env = specs[0]!.spawnEnv;

    // Integration's direct delivery.env passthrough.
    expect(env.MY_TOKEN).toBe("secret-123");
    // mcp-server's mcp_config.env, with ${user_config.API_KEY} rendered to the
    // value of the integration's MY_TOKEN.
    expect(env.SOMETHING).toBe("secret-123");
  });

  it("defaults user_config_key to the env-variable name when omitted (AFPS §7.6)", async () => {
    await seedAll(
      ctx,
      {
        // No user_config_key — default = "MY_TOKEN" (env-var name).
        envEntries: { MY_TOKEN: { field: "api_key" } },
        mcpConfigEnv: { SOMETHING: "${user_config.MY_TOKEN}" },
      },
      { api_key: "fallback-default" },
    );

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const env = specs[0]!.spawnEnv;
    expect(env.MY_TOKEN).toBe("fallback-default");
    expect(env.SOMETHING).toBe("fallback-default");
  });

  it("integration's delivery.env wins over a colliding mcp_config.env key", async () => {
    // Both the integration and the mcp-server declare an env var named
    // `TOKEN` — the integration's value must win because the integration is
    // the authoritative source for its server.
    await seedAll(
      ctx,
      {
        envEntries: { TOKEN: { field: "api_key" } },
        mcpConfigEnv: { TOKEN: "${user_config.TOKEN}" },
      },
      { api_key: "integration-wins" },
    );

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.spawnEnv.TOKEN).toBe("integration-wins");
  });

  it("passes through mcp_config.env keys with no matching user_config_key substitution", async () => {
    await seedAll(
      ctx,
      {
        envEntries: { MY_TOKEN: { field: "api_key" } },
        mcpConfigEnv: {
          BOUND: "${user_config.MY_TOKEN}",
          UNBOUND: "${user_config.UNKNOWN}",
          LITERAL: "static-value",
        },
      },
      { api_key: "live-secret" },
    );

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const env = specs[0]!.spawnEnv;
    expect(env.BOUND).toBe("live-secret");
    // Unknown placeholder renders to empty string (per renderMcpConfigEnv contract).
    expect(env.UNBOUND).toBe("");
    // Literal passes through unchanged.
    expect(env.LITERAL).toBe("static-value");
  });

  it("emits no mcp_config.env bridge when the referenced mcp-server omits one", async () => {
    await seedAll(
      ctx,
      {
        envEntries: { MY_TOKEN: { field: "api_key" } },
        mcpConfigEnv: {}, // empty — falsy after Object.keys filter
      },
      { api_key: "k" },
    );

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    // Only the integration's direct env entries flow through.
    expect(Object.keys(specs[0]!.spawnEnv)).toEqual(["MY_TOKEN"]);
  });
});
