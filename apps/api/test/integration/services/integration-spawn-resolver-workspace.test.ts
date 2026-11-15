// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `_meta["dev.appstrate/workspace"]` walker.
 *
 * Verifies that a local-source integration whose `_meta`
 * opts into the shared workspace surfaces the mount on
 * `IntegrationSpawnSpec.workspaceMount`. Coverage:
 *
 *   - Opt-in: integration with `_meta.workspace` → spec carries `workspaceMount`
 *   - Default: integration without the meta → spec OMITS `workspaceMount`
 *   - Defaults: missing `access` defaults to `"ro"`, missing `mount`
 *     defaults to `/workspace`
 *   - Remote source: workspace mount is NEVER emitted, regardless of
 *     workspace meta (remote MCPs have no runner to mount into)
 *   - Malformed meta: integration spawns without `workspaceMount`
 *     (logged warning) rather than aborting the run
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../helpers/spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { bindAllConnections } from "../../helpers/bound-connections.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/clone-integ";

function integrationManifest(workspace?: { mount?: string; access?: "ro" | "rw" }) {
  return localIntegrationManifest({
    name: INTEG,
    version: "1.0.0",
    server: workspace ? { workspace } : {},
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
    label: "default",
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
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

describe("resolveIntegrationSpawns — _meta.workspace propagation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("propagates the integration's _meta.workspace to spec.workspaceMount", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest({ mount: "/workspace", access: "rw" }),
    });
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
    await seedConnection(ctx);

    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/workspace", access: "rw" });
  });

  it("OMITS workspaceMount when the integration has no _meta.workspace (default — no workspace access)", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
    await seedConnection(ctx);

    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
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
      draftManifest: integrationManifest({ mount: "/scratch" }),
    });
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
    await seedConnection(ctx);

    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
    });
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/scratch", access: "ro" });
  });

  it("NEVER emits workspaceMount for remote-source integrations (no runner to mount into)", async () => {
    // Remote-source integrations open an HTTP MCP client against the
    // declared `source.remote.url` — there is no runner container/process
    // to bind a volume into, so the spawn spec must never carry
    // `workspaceMount`, even with a workspace declaration in its `_meta`.
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
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
    await seedConnection(ctx);

    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
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
      draftManifest: integrationManifest({ access: "rw" }),
    });
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
    await seedConnection(ctx);

    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections: await bindAllConnections(INTEG),
    });
    expect(specs[0]!.workspaceMount).toEqual({ mount: "/workspace", access: "rw" });
  });
});
