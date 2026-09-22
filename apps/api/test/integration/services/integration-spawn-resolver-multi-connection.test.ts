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
 * `connection` field that is now always present.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { ResolvedConnectionMap } from "@appstrate/core/integration";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPlacedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
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
  async function seedConnection(opts: { label: string; host: string }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEG,
        authKey: "key",
        accountId: opts.host,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        endUserId: null,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { host: opts.host, private_key: `key-for-${opts.host}` },
        }),
        identityClaims: { account_id: opts.host },
        label: opts.label,
        scopesGranted: [],
        needsReconnection: false,
        expiresAt: null,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /**
   * The kickoff snapshot the cascade writes for a bound set. Its `label` /
   * `accountId` are the run's AUDIT copy — deliberately stale here, because the
   * spawn spec must name each connection from its live row, not from this.
   */
  function snapshot(ids: string[]): ResolvedConnectionMap {
    return {
      [INTEG]: ids.map((connectionId, i) => ({
        connectionId,
        source: "member_pin" as const,
        label: `snapshot-label-${i}`,
        accountId: `snapshot-account-${i}`,
      })),
    };
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

    const { specs, dropped } = await resolve(snapshot([web, dbHost]));

    expect(dropped).toEqual([]);
    expect(specs).toHaveLength(2);

    // Same integration, same namespace, same tool surface — the sidecar keeps
    // ONE namespace and tells the two runners apart by label alone.
    expect(specs.map((s) => s.integrationId)).toEqual([INTEG, INTEG]);
    expect(specs.map((s) => s.namespace)).toEqual([INTEG, INTEG]);
    expect(specs.map((s) => s.toolAllowlist)).toEqual([["ssh_exec"], ["ssh_exec"]]);

    // What actually differs: the credential material and the handle. Both come
    // from the LIVE rows — the snapshot's audit copies say `snapshot-*`, so an
    // implementation that read them would fail here.
    expect(specs.map((s) => s.connection.label).sort()).toEqual(["db", "web-1"]);
    expect(specs.map((s) => s.connection.id).sort()).toEqual([web, dbHost].sort());
    expect(specs.map((s) => s.connection.accountId).sort()).toEqual([
      "db.example.com",
      "web-1.example.com",
    ]);

    const byLabel = new Map(specs.map((s) => [s.connection.label, s]));
    expect(byLabel.get("web-1")!.spawnEnv.SSH_HOST).toBe("web-1.example.com");
    expect(byLabel.get("web-1")!.spawnEnv.SSH_PRIVATE_KEY).toBe("key-for-web-1.example.com");
    expect(byLabel.get("db")!.spawnEnv.SSH_HOST).toBe("db.example.com");
    expect(byLabel.get("db")!.spawnEnv.SSH_PRIVATE_KEY).toBe("key-for-db.example.com");
  });

  it("CONTROL: one bound connection still yields exactly one spec, `connection` added", async () => {
    const web = await seedConnection({ label: "web-1", host: "web-1.example.com" });

    const { specs, dropped } = await resolve(snapshot([web]));

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

  it("drops only the member that lost its row, naming its label", async () => {
    // Plan §8 row 7, spawn half: the surviving sibling still spawns, and the
    // marker says WHICH connection the run lost — `integrationId` alone cannot.
    const web = await seedConnection({ label: "web-1", host: "web-1.example.com" });
    const gone = await seedConnection({ label: "db", host: "db.example.com" });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, gone));

    const { specs, dropped } = await resolve(snapshot([web, gone]));

    expect(specs).toHaveLength(1);
    expect(specs[0]!.connection.label).toBe("web-1");
    // The row is gone, so the drop is named from the snapshot's audit copy —
    // the only record of the connection the run bound that still exists.
    expect(dropped).toEqual([
      { integrationId: INTEG, reason: "no_delivery", connectionLabel: "snapshot-label-1" },
    ]);
  });
});
