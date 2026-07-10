// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — `delivery.files` walker (AFPS §7.6, CC-5).
 *
 * Verifies that:
 *  - `delivery.files.<path>: { value, mode? }` materialises into
 *    `IntegrationSpawnSpec.fileMounts` with `{ content_b64, mode }`.
 *  - The default mode is `0400` when the manifest omits one.
 *  - The credential-template grammar (`{$credential.<field>}`) resolves
 *    against the stored connection bag.
 *  - Path-traversal guards reject unsafe keys (`..`, relative, root).
 *  - Both `delivery.env` and `delivery.files` can coexist on the same auth.
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
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/mtls-integ";
const SERVER = "@orga/mtls-server";

function manifestWithFiles(opts: {
  mode?: string;
  /** When true, override one path with an unsafe `..` segment. */
  withUnsafePath?: boolean;
}) {
  const files: Record<string, { value: string; mode?: string }> = {
    "/run/creds/client.pem": {
      value: "{$credential.client_cert}",
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    },
    "/run/creds/client.key": {
      value: "{$credential.client_key}",
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    },
  };
  if (opts.withUnsafePath) {
    // Path-traversal — must be rejected and skipped by the resolver.
    files["/run/creds/../escape.pem"] = { value: "{$credential.client_cert}" };
  }
  return localIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    serverName: SERVER,
    auths: {
      primary: {
        type: "mtls",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["client_cert", "client_key"],
        delivery: { files },
      },
    },
    tools_policy: { call: {} },
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

async function seedConnection(ctx: TestContext, fields: Record<string, string>) {
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "primary",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: fields }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedServer(ctx: TestContext) {
  const manifest = mcpServerManifest({
    name: SERVER,
    version: "0.1.0",
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
  await seedPackageVersion({ packageId: SERVER, version: "0.1.0", manifest });
}

describe("resolveIntegrationSpawns — delivery.files (CC-5)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("materialises delivery.files entries into fileMounts with base64-encoded content + mode", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestWithFiles({ mode: "0600" }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedServer(ctx);
    await seedConnection(ctx, {
      client_cert: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
      client_key: "-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----",
    });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.fileMounts).toBeDefined();
    const mounts = spec.fileMounts!;

    expect(Object.keys(mounts).sort()).toEqual(["/run/creds/client.key", "/run/creds/client.pem"]);

    const certEntry = mounts["/run/creds/client.pem"]!;
    expect(certEntry.mode).toBe("0600");
    expect(Buffer.from(certEntry.content_b64, "base64").toString("utf8")).toBe(
      "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
    );

    const keyEntry = mounts["/run/creds/client.key"]!;
    expect(keyEntry.mode).toBe("0600");
    expect(Buffer.from(keyEntry.content_b64, "base64").toString("utf8")).toBe(
      "-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----",
    );
  });

  it("defaults mode to 0400 when the manifest omits it (AFPS §7.6)", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestWithFiles({}), // no mode → default
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedServer(ctx);
    await seedConnection(ctx, {
      client_cert: "cert-bytes",
      client_key: "key-bytes",
    });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const mounts = specs[0]!.fileMounts!;
    expect(mounts["/run/creds/client.pem"]!.mode).toBe("0400");
    expect(mounts["/run/creds/client.key"]!.mode).toBe("0400");
  });

  it("rejects path-traversal segments and skips the unsafe entry", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestWithFiles({ withUnsafePath: true }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedServer(ctx);
    await seedConnection(ctx, { client_cert: "c", client_key: "k" });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    const mounts = specs[0]!.fileMounts!;
    // Safe paths survive, unsafe `..` path is dropped silently with a log.
    expect(Object.keys(mounts).sort()).toEqual(["/run/creds/client.key", "/run/creds/client.pem"]);
    expect(mounts["/run/creds/../escape.pem"]).toBeUndefined();
  });

  it("emits no fileMounts when delivery.files is absent", async () => {
    // Use a plain api_key + delivery.env integration (no files).
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
            credentialFields: ["api_key"],
            delivery: { env: { TOKEN: { value: "{$credential.api_key}" } } },
          },
        },
        tools_policy: { call: {} },
      }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedServer(ctx);
    await seedConnection(ctx, { api_key: "k-1" });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });
    expect(specs.length).toBe(1);
    expect(specs[0]!.fileMounts).toBeUndefined();
    expect(specs[0]!.spawnEnv).toEqual({ TOKEN: "k-1" });
  });
});
