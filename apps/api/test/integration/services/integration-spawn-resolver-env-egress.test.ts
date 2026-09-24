// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — runner egress policy (#543, #1458).
 *
 * Every local-source runner whose auth declares an outbound surface gets
 * `spec.egress`: the connection's RENDERED `authorized_uris` plus
 * `allow_all_uris`. It is set whatever the delivery channel (env, http, mtls
 * files) — the sidecar's listener for that runner enforces it. A templated
 * entry that cannot be rendered is dropped, never passed raw (deny-all).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPlacedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
  envDelivery,
  filesDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/session-integ";
const SERVER = "@orga/session-server";

type Auth = Parameters<typeof localIntegrationManifest>[0]["auths"][string];

function integManifest(auth: Auth): IntegrationManifest {
  return localIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    serverName: SERVER,
    auths: { main: auth },
    tools_policy: { fetch: {} },
  });
}

const sessionAuth = (opts: { allowAllUris?: boolean } = {}): Auth => ({
  type: "custom",
  ...(opts.allowAllUris
    ? { allowAllUris: true }
    : { authorizedUris: ["https://crm.example.com/**"] }),
  credentialFields: ["zone", "user", "password"],
  delivery: envDelivery({ CRM_ZONE: "zone", CRM_USER: "user", CRM_PASSWORD: "password" }),
});

// SSH-like: the reachable host is whatever the USER entered on the connection.
const sshAuth: Auth = {
  type: "custom",
  authorizedUris: ["ssh://{$credential.host}:{$credential.port}"],
  credentialFields: ["host", "port", "password"],
  requiredCredentialFields: ["host", "port", "password"],
  delivery: envDelivery({ SSH_HOST: "host", SSH_PORT: "port", SSH_PASSWORD: "password" }),
};

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

async function resolveWith(
  ctx: TestContext,
  manifest: IntegrationManifest,
  outputs: Record<string, string>,
): Promise<IntegrationSpawnSpec> {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
  await seedPlacedPackage(ctx.defaultSpaceId, INTEG);
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
    authKey: "main",
    accountId: "default",
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const { specs } = await resolveIntegrationSpawns({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: agentManifest(),
  });
  expect(specs.length).toBe(1);
  return specs[0]!;
}

describe("resolveIntegrationSpawns — runner egress policy (#543, #1458)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("env delivery: sets egress (no fake httpDeliveryAuths) and delivers env creds", async () => {
    const spec = await resolveWith(ctx, integManifest(sessionAuth()), {
      zone: "phere",
      user: "lpayet",
      password: "secret",
    });

    expect(spec.spawnEnv).toMatchObject({
      CRM_ZONE: "phere",
      CRM_USER: "lpayet",
      CRM_PASSWORD: "secret",
    });
    expect(spec.egress).toEqual({
      authorizedUris: ["https://crm.example.com/**"],
      allowAllUris: false,
    });
    expect(spec.httpDeliveryAuths).toBeUndefined();
  });

  it("allow_all_uris: egress carries allowAllUris", async () => {
    const spec = await resolveWith(ctx, integManifest(sessionAuth({ allowAllUris: true })), {
      zone: "phere",
      user: "lpayet",
      password: "secret",
    });
    expect(spec.egress?.allowAllUris).toBe(true);
    expect(spec.httpDeliveryAuths).toBeUndefined();
  });

  it("http delivery: egress is set alongside the MITM plan, same rendered list", async () => {
    const spec = await resolveWith(
      ctx,
      integManifest({ type: "api_key", authorizedUris: ["https://api.example.com/**"] }),
      { api_key: "k-1" },
    );
    expect(spec.egress).toEqual({
      authorizedUris: ["https://api.example.com/**"],
      allowAllUris: false,
    });
    expect(spec.httpDeliveryAuths?.main?.authorizedUris).toEqual(["https://api.example.com/**"]);
  });

  it("mtls: egress is set (the CONNECT plane relays client-cert TLS blindly)", async () => {
    const spec = await resolveWith(
      ctx,
      integManifest({
        type: "mtls",
        authorizedUris: ["https://mtls.example.com/**"],
        credentialFields: ["client_cert", "client_key"],
        delivery: filesDelivery({
          "/run/creds/client.pem": { field: "client_cert" },
          "/run/creds/client.key": { field: "client_key" },
        }),
      }),
      { client_cert: "CERT", client_key: "KEY" },
    );
    expect(spec.fileMounts).toBeDefined();
    expect(spec.egress).toEqual({
      authorizedUris: ["https://mtls.example.com/**"],
      allowAllUris: false,
    });
  });

  it("renders a templated entry from the connection's fields", async () => {
    const spec = await resolveWith(ctx, integManifest(sshAuth), {
      host: "h",
      port: "22",
      password: "pw",
    });
    expect(spec.egress).toEqual({ authorizedUris: ["ssh://h:22"], allowAllUris: false });
  });

  it("a missing field drops the entry (deny-all), never the raw template", async () => {
    const spec = await resolveWith(ctx, integManifest(sshAuth), { host: "h", password: "pw" });
    expect(spec.egress).toEqual({ authorizedUris: [], allowAllUris: false });
  });

  it("a field that is not a literal host drops the entry", async () => {
    const spec = await resolveWith(ctx, integManifest(sshAuth), {
      host: "evil.example.com/x",
      port: "22",
      password: "pw",
    });
    expect(spec.egress).toEqual({ authorizedUris: [], allowAllUris: false });
  });
});
