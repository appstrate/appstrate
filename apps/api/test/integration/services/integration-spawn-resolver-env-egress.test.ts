// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — env-delivery egress signal (#543).
 *
 * A `delivery.env` local-source integration (the server holds its own
 * credentials and authenticates itself — e.g. a form/session login) sits on
 * the per-run network with no direct egress in docker mode. It resolves NO
 * injection plan, so the resolver raises an explicit `needsEgress` flag and
 * the sidecar mounts a plain CONNECT egress listener for it (tunnel + SSRF
 * floor, no TLS termination, no cert mint). It must NOT emit a fake
 * `httpDeliveryAuths` entry (the pre-#543 presence-token workaround). The env
 * credentials are delivered separately via `spawnEnv`.
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
  envDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/session-integ";
const SERVER = "@orga/session-server";

function integManifest(opts: { allowAllUris?: boolean } = {}) {
  return localIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    serverName: SERVER,
    auths: {
      session: {
        type: "custom",
        ...(opts.allowAllUris
          ? { allowAllUris: true }
          : { authorizedUris: ["https://crm.example.com/**"] }),
        credentialFields: ["zone", "user", "password"],
        delivery: envDelivery({
          CRM_ZONE: "zone",
          CRM_USER: "user",
          CRM_PASSWORD: "password",
        }),
      },
    },
    tools_policy: { fetch: {} },
  });
}

function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    display_name: "Agent",
    author: "t",
    dependencies: { integrations: { [INTEG]: "^0.1.0" } },
    integrations_configuration: { [INTEG]: { tools: ["fetch"] } },
  };
}

async function seedAll(ctx: TestContext, manifest: Record<string, unknown>) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
  await seedInstalledPackage(ctx.defaultAppId, INTEG);
  const serverManifest = mcpServerManifest({
    name: SERVER,
    version: "0.1.0",
    serverType: "python",
    entryPoint: "./server.py",
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
    authKey: "session",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({
      outputs: { zone: "phere", user: "lpayet", password: "secret" },
    }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("resolveIntegrationSpawns — env-delivery egress signal (#543)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("raises needsEgress (no fake httpDeliveryAuths) and delivers env creds", async () => {
    await seedAll(ctx, integManifest());

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;

    // Credentials reach the runner via env (the server authenticates itself).
    expect(spec.spawnEnv).toMatchObject({
      CRM_ZONE: "phere",
      CRM_USER: "lpayet",
      CRM_PASSWORD: "secret",
    });

    // The runner gets an explicit egress signal — and NO fake injection plan.
    // The sidecar mounts a plain CONNECT egress listener off `needsEgress`.
    expect(spec.needsEgress).toBe(true);
    expect(spec.httpDeliveryAuths).toBeUndefined();
  });

  it("also signals egress for an allow_all_uris env integration", async () => {
    await seedAll(ctx, integManifest({ allowAllUris: true }));

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    const spec = specs[0]!;
    expect(spec.needsEgress).toBe(true);
    expect(spec.httpDeliveryAuths).toBeUndefined();
  });
});
