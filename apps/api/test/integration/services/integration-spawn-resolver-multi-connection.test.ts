// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — ONE spec per bound connection.
 *
 * An agent declares `@orga/ssh` once; the run binds one or more SSH
 * connections to it (one host each). The resolver emits one
 * `IntegrationSpawnSpec` per connection: same `integrationId`, same
 * `namespace`, same tool surface — only `spawnEnv` and `spec.connection`
 * differ, which is what lets the sidecar route `(tool, label) → client`
 * without suffixing tool names.
 *
 * Each case carries its control: the single-connection run must still produce
 * exactly the spec it produced before the set model existed, plus the
 * `connection` field, which is present whenever a connection was bound.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { ResolvedConnectionMap } from "@appstrate/core/integration";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { bindAllConnections } from "../../helpers/bound-connections.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPlacedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  apiIntegrationManifest,
  localIntegrationManifest,
  mcpServerManifest,
  envDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/ssh";
const SERVER = "@orga/ssh-server";

function integManifest() {
  return localIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    serverName: SERVER,
    auths: {
      key: {
        type: "custom",
        authorizedUris: ["https://ssh.example.com/**"],
        credentialFields: ["host", "private_key"],
        delivery: envDelivery({ SSH_HOST: "host", SSH_PRIVATE_KEY: "private_key" }),
      },
    },
    tools_policy: { ssh_exec: {} },
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
    integrations_configuration: { [INTEG]: { tools: ["ssh_exec"] } },
  };
}

describe("resolveIntegrationSpawns — one spec per bound connection", () => {
  let ctx: TestContext;

  /** Seed the integration + its referenced mcp-server. */
  async function seedIntegration() {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integManifest(),
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
  }

  /** One SSH connection = one host, as `@appstrate/ssh` models it. */
  async function seedConnection(opts: {
    label: string;
    host: string;
    accountId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEG,
        authKey: "key",
        accountId: opts.accountId ?? opts.host,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { host: opts.host, private_key: `key-for-${opts.host}` },
        }),
        identityClaims: {},
        label: opts.label,
        scopesGranted: [],
        needsReconnection: false,
        expiresAt: null,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function resolve(resolvedConnections: ResolvedConnectionMap) {
    return resolveIntegrationSpawns({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
      resolvedConnections,
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedIntegration();
  });

  it("emits TWO specs with distinct spawnEnv and distinct connection labels", async () => {
    const web = await seedConnection({ label: "web-1", host: "web-1.example.com" });
    const dbHost = await seedConnection({ label: "db", host: "db.example.com" });

    const { specs, dropped } = await resolve(await bindAllConnections(INTEG));

    expect(dropped).toEqual([]);
    expect(specs).toHaveLength(2);

    // Same integration, same namespace, same tool surface — the sidecar keeps
    // ONE namespace and tells the two runners apart by label alone.
    expect(specs.map((s) => s.integrationId)).toEqual([INTEG, INTEG]);
    expect(specs.map((s) => s.namespace)).toEqual([INTEG, INTEG]);
    expect(specs.map((s) => s.toolAllowlist)).toEqual([["ssh_exec"], ["ssh_exec"]]);

    // What actually differs: the credential material and the handle.
    expect(specs.map((s) => s.connection!.label).sort()).toEqual(["db", "web-1"]);
    expect(specs.map((s) => s.connection!.id).sort()).toEqual([web, dbHost].sort());
    expect(specs.map((s) => s.connection!.accountId).sort()).toEqual([
      "db.example.com",
      "web-1.example.com",
    ]);

    const byLabel = new Map(specs.map((s) => [s.connection!.label, s]));
    expect(byLabel.get("web-1")!.spawnEnv.SSH_HOST).toBe("web-1.example.com");
    expect(byLabel.get("web-1")!.spawnEnv.SSH_PRIVATE_KEY).toBe("key-for-web-1.example.com");
    expect(byLabel.get("db")!.spawnEnv.SSH_HOST).toBe("db.example.com");
    expect(byLabel.get("db")!.spawnEnv.SSH_PRIVATE_KEY).toBe("key-for-db.example.com");
  });

  it("CONTROL: one bound connection still yields exactly one spec, `connection` added", async () => {
    const web = await seedConnection({ label: "web-1", host: "web-1.example.com" });

    const { specs, dropped } = await resolve(await bindAllConnections(INTEG));

    expect(dropped).toEqual([]);
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.integrationId).toBe(INTEG);
    expect(spec.namespace).toBe(INTEG);
    expect(spec.toolAllowlist).toEqual(["ssh_exec"]);
    expect(spec.spawnEnv).toMatchObject({
      SSH_HOST: "web-1.example.com",
      SSH_PRIVATE_KEY: "key-for-web-1.example.com",
    });
    expect(spec.connection).toEqual({
      id: web,
      label: "web-1",
      accountId: "web-1.example.com",
    });
  });

  // The kickoff cascade checked the set's labels are distinct on the SNAPSHOT;
  // a rename afterwards must not reach the sidecar unchecked.
  it("names each connection by its snapshot label, not a rename made since kickoff", async () => {
    await seedConnection({ label: "web-1", host: "web-1.example.com" });
    const dbHost = await seedConnection({ label: "db", host: "db.example.com" });
    const bound = await bindAllConnections(INTEG);
    await db
      .update(integrationConnections)
      .set({ label: "web-1" })
      .where(eq(integrationConnections.id, dbHost));

    const { specs } = await resolve(bound);

    expect(specs.map((s) => s.connection!.label).sort()).toEqual(["db", "web-1"]);
  });

  // `account_id` is ONE value wherever it is shown: the column the cascade
  // snapshots and the 412 candidates carry. Its identity-less placeholder is no
  // account, so it reaches the sidecar as null.
  it("carries the account_id column, with the identity-less placeholder as null", async () => {
    const mail = await seedConnection({
      label: "ops",
      host: "ops.example.com",
      accountId: "ops@example.com",
    });
    const anon = await seedConnection({
      label: "anon",
      host: "anon.example.com",
      accountId: "default",
    });

    const { specs } = await resolve(await bindAllConnections(INTEG));

    const byId = new Map(specs.map((s) => [s.connection!.id, s.connection!.accountId]));
    expect(byId.get(mail)).toBe("ops@example.com");
    expect(byId.get(anon)).toBeNull();
  });

  // Plan §8 row 7, spawn half: a set that lost a member is not spawned at all.
  // With one survivor the sidecar would inject no `connection` selector, and
  // every call meant for the lost host would silently run on the other one.
  it("drops the WHOLE set when one member lost its row, naming every member", async () => {
    await seedConnection({ label: "web-1", host: "web-1.example.com" });
    const gone = await seedConnection({ label: "db", host: "db.example.com" });
    const bound = await bindAllConnections(INTEG);
    await db.delete(integrationConnections).where(eq(integrationConnections.id, gone));

    const { specs, dropped } = await resolve(bound);

    expect(specs).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped).toContainEqual({
      integrationId: INTEG,
      reason: "no_delivery",
      connectionLabel: "db",
    });
    expect(dropped).toContainEqual(
      expect.objectContaining({
        integrationId: INTEG,
        reason: "bound_set_incomplete",
        connectionLabel: "web-1",
      }),
    );
  });
});

/**
 * Each api_call tool belongs to ONE auth. A connection made on `backup` must
 * not be handed `api_call__primary`: that tool would go out uncredentialed, and
 * its 401 would flag the `backup` connection for reconnection.
 */
describe("resolveIntegrationSpawns — api_call per connection auth", () => {
  const API = "@orga/twoauth";
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    const manifest = apiIntegrationManifest({
      name: API,
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://a.example.com/**"],
          credentialFields: ["api_key"],
        },
        backup: {
          type: "api_key",
          authorizedUris: ["https://b.example.com/**"],
          credentialFields: ["api_key"],
        },
      },
    });
    (manifest as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": { auths: { primary: {}, backup: {} } },
    };
    await seedPackage({
      id: API,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    await seedPlacedPackage(ctx.defaultSpaceId, API);
  });

  async function seedOn(authKey: string, label: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: API,
        authKey,
        accountId: label,
        label,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: `k-${label}` } }),
        identityClaims: {},
        scopesGranted: [],
        needsReconnection: false,
        expiresAt: null,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("gives each spec only the api_call of its connection's auth", async () => {
    const onPrimary = await seedOn("primary", "main");
    const onBackup = await seedOn("backup", "spare");

    const { specs, dropped } = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: {
        schema_version: "0.2",
        type: "agent",
        name: "@orga/agent",
        version: "0.1.0",
        display_name: "Agent",
        dependencies: { integrations: { [API]: "^1.0.0" } },
        integrations_configuration: { [API]: { tools: "*" } },
      },
      resolvedConnections: await bindAllConnections(API),
    });

    expect(dropped).toEqual([]);
    const authsOf = new Map(
      specs.map((s) => [s.connection!.id, (s.apiCalls ?? []).map((c) => c.authKey)]),
    );
    expect(authsOf.get(onPrimary)).toEqual(["primary"]);
    expect(authsOf.get(onBackup)).toEqual(["backup"]);
  });
});
