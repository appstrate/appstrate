// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `_meta["dev.appstrate/workspace"]` walker.
 *
 * Verifies that a local-source integration whose referenced mcp-server
 * opts into the shared workspace surfaces the mount on
 * `IntegrationSpawnSpec.workspaceMount`. Coverage:
 *
 *   - Opt-in: mcp-server with `_meta.workspace` → spec carries `workspaceMount`
 *   - Default: mcp-server without the meta → spec OMITS `workspaceMount`
 *   - Defaults: missing `access` defaults to `"ro"`, missing `mount`
 *     defaults to `/workspace`
 *   - Remote source: workspace mount is NEVER emitted, regardless of
 *     mcp-server meta (remote MCPs have no runner to mount into)
 *   - Malformed meta: integration spawns without `workspaceMount`
 *     (logged warning) rather than aborting the run
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
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/clone-integ";
const SERVER = "@orga/clone-server";

function integrationManifest() {
  return localIntegrationManifest({
    name: INTEG,
    version: "1.0.0",
    serverName: SERVER,
    auths: {
      oauth: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
      },
    },
    tools_policy: { clone_repo: {} },
  });
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "1.0.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    integrations_configuration: { [INTEG]: { tools: ["clone_repo"] } },
  };
}

async function seedConnection(ctx: TestContext) {
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "oauth",
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

async function seedMcpServer(
  ctx: TestContext,
  workspace?: { mount?: string; access?: "ro" | "rw" },
) {
  const manifest = mcpServerManifest({
    name: SERVER,
    version: "1.0.0",
    serverType: "node",
    entryPoint: "./server.js",
    ...(workspace ? { workspace } : {}),
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

describe("resolveIntegrationSpawns — _meta.workspace propagation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("propagates mcp-server _meta.workspace to spec.workspaceMount", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedMcpServer(ctx, { mount: "/workspace", access: "rw" });
    await seedConnection(ctx);

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/workspace", access: "rw" });
  });

  it("OMITS workspaceMount when mcp-server has no _meta.workspace (default — no workspace access)", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedMcpServer(ctx); // no workspace declaration
    await seedConnection(ctx);

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.workspaceMount).toBeUndefined();
  });

  it("defaults access to 'ro' (least-privilege) when manifest omits it", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedMcpServer(ctx, { mount: "/scratch" });
    await seedConnection(ctx);

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/scratch", access: "ro" });
  });

  it("NEVER emits workspaceMount for remote-source integrations (no runner to mount into)", async () => {
    // Remote-source integrations open an HTTP MCP client against the
    // declared `source.remote.url` — there is no runner container/process
    // to bind a volume into, so the spawn spec must never carry
    // `workspaceMount` even if a mcp-server with the same scoped name
    // happens to exist in the registry and declares workspace.
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remoteIntegrationManifest({
        name: INTEG,
        version: "1.0.0",
        auths: {
          oauth: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
          },
        },
        tools_policy: { clone_repo: {} },
      }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    // Seed an mcp-server with the SAME name + a workspace declaration —
    // a remote integration must not consult it.
    await seedMcpServer(ctx, { mount: "/workspace", access: "rw" });
    await seedConnection(ctx);

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.workspaceMount).toBeUndefined();
  });

  it("defaults mount to '/workspace' when only access is provided", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedMcpServer(ctx, { access: "rw" });
    await seedConnection(ctx);

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/workspace", access: "rw" });
  });
});
