// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `source.kind: "remote"` (Phase 7 Streamable HTTP MCP) and
 * the source-discriminant error guards. A remote integration sets the spec's
 * `sourceKind: "remote"`, emits a server spec of `{ url, transport }` (no
 * `type` sentinel — dispatch keys on `sourceKind`), and deliberately drops
 * `httpDeliveryAuths` (the sidecar injects the token directly, no MITM
 * listener). A remote source missing its `source.remote` block yields no
 * spawn.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  remoteIntegrationManifest,
  localIntegrationManifest,
  httpHeaderDelivery,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/remote-mcp";

function manifest(withRemote = true) {
  return remoteIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    withRemote,
    url: "https://mcp.example.com/mcp/v1",
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://mcp.example.com/**"],
        credentialFields: ["api_key"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
    tools_policy: { search: {} },
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
    integrations_configuration: { [INTEG]: { tools: ["search"] } },
  };
}

describe("resolveIntegrationSpawns — remote source", () => {
  let ctx: TestContext;

  async function seed(withRemote: boolean) {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(withRemote),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    // An api_key connection so resolveDeliveries finds a row and the resolver
    // proceeds to the source-discriminant block.
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("emits sourceKind=remote with a { url, transport } server spec and drops httpDeliveryAuths", async () => {
    await seed(true);
    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.sourceKind).toBe("remote");
    expect(spec.manifest.server).toEqual({
      url: "https://mcp.example.com/mcp/v1",
      transport: "streamable-http",
    });
    // Remote HTTP MCP bypasses the per-integration MITM listener.
    expect(spec.httpDeliveryAuths).toBeUndefined();
  });

  it("yields no spawn when a remote source omits source.remote.url", async () => {
    await seed(false);
    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(0);
  });
});

describe("resolveIntegrationSpawns — local source error guards", () => {
  const LOCAL = "@orga/local-integ";
  const MISSING_SERVER = "@orga/no-such-server";
  let ctx: TestContext;

  function localManifest(serverName: string) {
    return localIntegrationManifest({
      name: LOCAL,
      serverName,
      version: "0.1.0",
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
    });
  }

  function localAgent(): Record<string, unknown> {
    return {
      schema_version: "0.2",
      type: "agent",
      name: "@orga/agent",
      version: "0.1.0",
      display_name: "Agent",
      dependencies: { integrations: { [LOCAL]: "^0.1.0" } },
      integrations_configuration: { [LOCAL]: { tools: ["search"] } },
    };
  }

  async function seedConnection() {
    await db.insert(integrationConnections).values({
      integrationId: LOCAL,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("yields no spawn when the referenced mcp-server package does not exist", async () => {
    await seedPackage({
      id: LOCAL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localManifest(MISSING_SERVER),
    });
    await seedInstalledPackage(ctx.defaultAppId, LOCAL);
    await seedConnection();

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: localAgent(),
    });
    expect(specs.length).toBe(0);
  });

  it("applies the mcp-server _meta runtime override to the spawn spec server type", async () => {
    const SERVER = "@orga/bun-server";
    await seedPackage({
      id: LOCAL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localManifest(SERVER),
    });
    // The mcp-server keeps an MCPB-vocabulary server.type "node" and declares
    // the real runtime under _meta — the resolver must surface `bun`, not `node`.
    const serverManifest = mcpServerManifest({
      name: SERVER,
      version: "0.1.0",
      serverType: "node",
      entryPoint: "./server.ts",
      appstrateRuntime: "bun",
    });
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: serverManifest,
    });
    await seedPackageVersion({ packageId: SERVER, version: "0.1.0", manifest: serverManifest });
    await seedInstalledPackage(ctx.defaultAppId, LOCAL);
    await seedConnection();

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: localAgent(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.manifest.server).toEqual({
      type: "bun",
      entry_point: "./server.ts",
      packageId: SERVER,
      version: "0.1.0",
    });
  });
});
