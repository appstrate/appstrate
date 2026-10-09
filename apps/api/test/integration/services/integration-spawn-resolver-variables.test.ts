// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — connection variables (AFPS §7.12). A templated `source.remote.url` renders per
 * bound connection from that connection's variables and is egress-checked per connection: a
 * connection whose URL does not render, or renders to a refused host, drops alone (and so its
 * whole bound set). Delivery templates and `authorized_uris` render `{$variable.<name>}` too.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { bindAllConnections } from "../../helpers/bound-connections.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPlacedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  loadAccessibleConnectionById,
  persistCredentialBundle,
} from "../../../src/services/integration-connections.ts";
import {
  connectToolBlock,
  httpHeaderDelivery,
  localIntegrationManifest,
  mcpServerManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEG = "@orga/forge-mcp";
const SERVER = "@orga/forge-server";

const VARIABLES = {
  schema: {
    type: "object",
    properties: { base_url: { type: "string", format: "uri" } },
    required: ["base_url"],
  },
};

function withVariables(manifest: IntegrationManifest, variables: unknown = VARIABLES) {
  return { ...manifest, variables } as unknown as IntegrationManifest;
}

function remoteManifest(url = "{$variable.base_url}/mcp") {
  return withVariables(
    remoteIntegrationManifest({
      name: INTEG,
      version: "0.1.0",
      url,
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["{$variable.base_url}/**"],
          credentialFields: ["api_key"],
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
      tools_policy: { search: {} },
    }),
  );
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

async function seedIntegration(ctx: TestContext, manifest: IntegrationManifest) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
  await seedPlacedPackage(ctx.defaultSpaceId, INTEG);
}

async function seedConnection(
  ctx: TestContext,
  label: string,
  variables: Record<string, string> | null,
  outputs: Record<string, string> = { api_key: "k-123" },
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: label,
      label,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs }),
      variables,
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function resolve(ctx: TestContext) {
  return resolveIntegrationSpawns({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: agentManifest(),
    resolvedConnections: await bindAllConnections(INTEG),
  });
}

describe("resolveIntegrationSpawns — templated source.remote.url", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("renders the remote URL from the connection's variables", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "default", { base_url: "https://mcp.example.com/forge/" });

    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.manifest.server).toEqual({
      url: "https://mcp.example.com/forge/mcp",
      transport: "streamable-http",
    });
  });

  it("gives each bound connection the URL its own variables render", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "a", { base_url: "https://mcp.example.com" });
    await seedConnection(ctx, "b", { base_url: "https://api.example.com" });

    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    const urls = Object.fromEntries(
      specs.map((s) => [s.connection!.label, s.manifest.server?.url]),
    );
    expect(urls).toEqual({ a: "https://mcp.example.com/mcp", b: "https://api.example.com/mcp" });
  });

  it("drops a connection whose variables do not render the URL, and its bound set with it", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "a", { base_url: "https://mcp.example.com" });
    await seedConnection(ctx, "b", { base_url: "https://api.example.com/?tenant=x" });

    const { specs, dropped } = await resolve(ctx);
    expect(specs).toEqual([]);
    expect(dropped).toContainEqual(
      expect.objectContaining({ reason: "remote_url_unrenderable", connectionLabel: "b" }),
    );
    expect(dropped).toContainEqual(
      expect.objectContaining({ reason: "bound_set_incomplete", connectionLabel: "a" }),
    );
  });

  it("drops a connection that holds no variables", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "default", null);

    const { specs, dropped } = await resolve(ctx);
    expect(specs).toEqual([]);
    expect(dropped).toEqual([
      expect.objectContaining({ reason: "remote_url_unrenderable", connectionLabel: "default" }),
    ]);
  });

  it("drops a connection whose rendered host the egress guard refuses", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "default", { base_url: "https://169.254.169.254" });

    const { specs, dropped } = await resolve(ctx);
    expect(specs).toEqual([]);
    expect(dropped).toEqual([
      expect.objectContaining({ reason: "remote_url_blocked", connectionLabel: "default" }),
    ]);
    expect(dropped[0]!.detail).toContain("169.254.169.254");
  });

  it("refuses a rendered plain-http URL for a host the operator does not trust", async () => {
    await seedIntegration(ctx, remoteManifest());
    await seedConnection(ctx, "default", { base_url: "http://forge.example.org" });

    const { dropped } = await resolve(ctx);
    expect(dropped).toEqual([
      expect.objectContaining({ reason: "remote_url_blocked", connectionLabel: "default" }),
    ]);
  });

  it("keeps a literal remote URL as declared, whatever the connection's variables", async () => {
    await seedIntegration(ctx, remoteManifest("https://mcp.example.com/mcp/v1"));
    await seedConnection(ctx, "default", { base_url: "https://api.example.com" });

    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    expect(specs[0]!.manifest.server?.url).toBe("https://mcp.example.com/mcp/v1");
  });

  it("fails a literal remote URL the egress guard refuses for the whole integration, as before", async () => {
    await seedIntegration(ctx, remoteManifest("https://169.254.169.254/mcp"));
    await seedConnection(ctx, "default", { base_url: "https://api.example.com" });

    const { specs, dropped } = await resolve(ctx);
    expect(specs).toEqual([]);
    expect(dropped).toEqual([
      expect.objectContaining({ reason: "resolve_error", integrationId: INTEG }),
    ]);
    expect(dropped[0]!.connectionLabel).toBeUndefined();
  });
});

describe("resolveIntegrationSpawns — delivery templates with connection variables", () => {
  let ctx: TestContext;

  async function seedLocal(delivery: Record<string, unknown>) {
    await seedIntegration(
      ctx,
      withVariables(
        localIntegrationManifest({
          name: INTEG,
          version: "0.1.0",
          serverName: SERVER,
          auths: {
            primary: {
              type: "api_key",
              authorizedUris: ["{$variable.base_url}/api/**"],
              credentialFields: ["api_key"],
              delivery,
            },
          },
          tools_policy: { search: {} },
        }),
      ),
    );
  }

  const HTTP_DELIVERY = {
    http: {
      in: "header",
      name: "X-Forge-Key",
      value: "{$variable.base_url}|{$credential.api_key}",
    },
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    const server = mcpServerManifest({
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
      draftManifest: server,
    });
    await seedPackageVersion({ packageId: SERVER, version: "0.1.0", manifest: server });
  });

  it("renders delivery.http and authorized_uris from the variables", async () => {
    await seedLocal(HTTP_DELIVERY);
    await seedConnection(ctx, "default", { base_url: "https://forge.example.com" });

    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    const spec = specs[0]!;
    expect(spec.httpDeliveryAuths?.primary).toMatchObject({
      headerName: "X-Forge-Key",
      value: "https://forge.example.com|k-123",
      authorizedUris: ["https://forge.example.com/api/**"],
    });
    expect(spec.egress).toEqual({
      authorizedUris: ["https://forge.example.com/api/**"],
      allowAllUris: false,
    });
  });

  it("renders delivery.env and delivery.files from the variables", async () => {
    await seedLocal({
      env: { FORGE_URL: { value: "{$variable.base_url}" } },
      files: { "/run/creds/forge.txt": { value: "{$variable.base_url}" } },
    });
    await seedConnection(ctx, "default", { base_url: "https://forge.example.com" });

    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    const spec = specs[0]!;
    expect(spec.spawnEnv.FORGE_URL).toBe("https://forge.example.com");
    expect(
      Buffer.from(spec.fileMounts!["/run/creds/forge.txt"]!.content_b64, "base64").toString(),
    ).toBe("https://forge.example.com");
  });

  it("renders no authorized_uris entry from an invalid variable value (deny-all)", async () => {
    await seedLocal(HTTP_DELIVERY);
    const id = await seedConnection(ctx, "default", { base_url: "https://forge.example.com" });
    await db
      .update(integrationConnections)
      .set({ variables: { base_url: "forge.example.com" } })
      .where(eq(integrationConnections.id, id));

    const { specs } = await resolve(ctx);
    expect(specs[0]!.httpDeliveryAuths?.primary?.authorizedUris).toEqual([]);
    expect(specs[0]!.egress).toEqual({ authorizedUris: [], allowAllUris: false });
  });
});

describe("resolveIntegrationSpawns — run-start connect.tool with connection variables", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedIntegration(
      ctx,
      withVariables({
        ...(remoteIntegrationManifest({
          name: INTEG,
          version: "0.1.0",
          url: "{$variable.base_url}/mcp",
          auths: {
            session: {
              type: "custom",
              authorizedUris: ["{$variable.base_url}/**"],
              credentialFields: ["password"],
              delivery: {
                http: { in: "header", name: "Cookie", value: "sid={$credential.sid}" },
              },
              connect: connectToolBlock({
                tool: "login",
                runAt: "run-start",
                persistLoginSecret: true,
                produces: ["sid"],
              }),
            },
          },
          tools_policy: { search: {}, login: {} },
        }) as unknown as Record<string, unknown>),
      } as unknown as IntegrationManifest),
    );
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "session",
      accountId: "default",
      label: "default",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({
        outputs: {},
        inputs: { password: "s3cr3t" },
      }),
      variables: { base_url: "https://mcp.example.com/forge" },
    });
  });

  it("hands the sidecar the allowlist rendered from the variables, and the variables", async () => {
    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    const spec = specs[0]!;
    expect(spec.manifest.server?.url).toBe("https://mcp.example.com/forge/mcp");
    expect(spec.connectLogin).toMatchObject({
      authorizedUris: ["https://mcp.example.com/forge/**"],
      variables: { base_url: "https://mcp.example.com/forge" },
      inputs: { password: "s3cr3t" },
    });
  });
});

describe("connection rows carry their variables", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedIntegration(ctx, remoteManifest());
  });

  const load = (id: string) =>
    loadAccessibleConnectionById(id, INTEG, null, {
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
    });

  it("reads the variables in the statement that reads the credential, own strings only", async () => {
    const id = await seedConnection(ctx, "default", {
      base_url: "https://mcp.example.com/forge",
      port: 443,
    } as unknown as Record<string, string>);
    expect((await load(id))!.variables).toEqual({ base_url: "https://mcp.example.com/forge" });
  });

  it("a token refresh rewrites the credential and leaves the variables and the resource", async () => {
    const id = await seedConnection(ctx, "default", { base_url: "https://mcp.example.com/forge" });
    await db
      .update(integrationConnections)
      .set({ oauthResource: "https://mcp.example.com/forge/mcp" })
      .where(eq(integrationConnections.id, id));
    const held = (await load(id))!;

    await persistCredentialBundle(
      { kind: "update-by-id", connectionId: id, expect: held },
      { credentials: { api_key: "k-456" }, expiresAt: null, needsReconnection: false },
    );

    const after = (await load(id))!;
    expect(after.credentialsEncrypted).not.toBe(held.credentialsEncrypted);
    expect(after.variables).toEqual(held.variables);
    expect(after.oauthResource).toBe("https://mcp.example.com/forge/mcp");
    const { specs, dropped } = await resolve(ctx);
    expect(dropped).toEqual([]);
    expect(specs[0]!.manifest.server?.url).toBe("https://mcp.example.com/forge/mcp");
  });

  it("an acquisition without a resource clears the stored one", async () => {
    const id = await seedConnection(ctx, "default", { base_url: "https://mcp.example.com/forge" });
    await db
      .update(integrationConnections)
      .set({ oauthResource: "https://mcp.example.com/forge/mcp" })
      .where(eq(integrationConnections.id, id));

    await persistCredentialBundle(
      {
        kind: "update-owned",
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        actor: { type: "user", id: ctx.user.id },
        connectionId: id,
        packageId: INTEG,
        authKey: "primary",
      },
      {
        credentials: { api_key: "k-789" },
        variables: { base_url: "https://mcp.example.com/forge" },
      },
    );
    expect((await load(id))!.oauthResource).toBeNull();
  });
});
