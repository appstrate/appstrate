// SPDX-License-Identifier: Apache-2.0

/**
 * Reconnecting a connection keeps its scope (#1870): a delegated credential (API key, third-party
 * token) creates and renews only rows scoped to its space, never one serving the whole org; and an
 * org-scoped row reconnects through an org or system client, never narrowed onto its space's own.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Hono } from "hono";
import type { AppstrateModule, AuthResolution } from "@appstrate/core/module";
import type { AppEnv } from "../../../src/types/index.ts";
import { eq } from "drizzle-orm";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import { oauthStateStore } from "../../../src/services/connect/oauth-state-store.ts";
import { saveIntegrationConnection } from "../../../src/services/integration-connections.ts";
import { runWidenConnectionsToOrgScope } from "../../../../../scripts/migration/0041-widen-connections-to-org-scope.ts";

const INTEGRATION = "@myorg/probe";
const SYSTEM_ID = "probe-system";

const manifest = localIntegrationManifest({
  name: INTEGRATION,
  version: "0.1.0",
  auths: {
    api: {
      type: "api_key",
      authorizedUris: ["https://api.example.com/**"],
      delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" }),
    },
    google: {
      type: "oauth2",
      authorizationEndpoint: "https://accounts.example.com/authorize",
      tokenEndpoint: "https://accounts.example.com/token",
      defaultScopes: ["openid"],
      authorizedUris: ["https://api.example.com/**"],
      delivery: httpHeaderDelivery({
        name: "Authorization",
        prefix: "Bearer ",
        field: "access_token",
      }),
    },
  },
});

let ctx: TestContext;

/** An org-bound delegate pinning no space (a third-party token): it acts in the `X-Space-Id` space. */
const unpinnedDelegate: AppstrateModule = {
  manifest: { id: "unpinned-delegate", name: "Unpinned Delegate", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [
      {
        id: "unpinned-delegate",
        async authenticate({ headers }) {
          const orgId = headers.get("x-test-delegate-org");
          if (!orgId) return null;
          return {
            user: ctx.user,
            orgId,
            orgRole: "admin",
            authMethod: "test-unpinned-delegate",
            principalKind: "delegate",
            permissions: ["integrations:connect"],
          } satisfies AuthResolution;
        },
      },
    ];
  },
};

/** Its own app: a strategy is contributed by a module, and the default app loads none. */
const delegateApp = getTestApp({ modules: [unpinnedDelegate] });
// Built last: `getTestApp` registers the permission providers of the modules it is given.
const app = getTestApp();

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "myorg" });
  await seedPackage({
    id: INTEGRATION,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
    homeSpaceId: ctx.defaultSpaceId,
  });
  await seedSpacePackage(ctx.defaultSpaceId, INTEGRATION);
  initSystemIntegrations([
    {
      id: INTEGRATION,
      clients: [
        { id: SYSTEM_ID, auth_key: "google", client_id: "sys-client", client_secret: "sys" },
      ],
    },
  ]);
});

afterEach(() => __resetSystemIntegrationsForTest());

async function seedRow(authKey: string, spaceId: string | null, clientRef?: string) {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey,
      accountId: "default",
      orgId: ctx.orgId,
      spaceId,
      originSpaceId: spaceId === null ? ctx.defaultSpaceId : null,
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "old" } }),
      clientRef: clientRef ?? null,
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning();
  return row!;
}

async function scopeOf(id: string) {
  const [row] = await db
    .select({
      spaceId: integrationConnections.spaceId,
      originSpaceId: integrationConnections.originSpaceId,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row;
}

async function ciphertextOf(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ secret: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row?.secret;
}

function post(
  path: string,
  headers: Record<string, string>,
  body: unknown,
  through: Hono<AppEnv> = app,
) {
  return through.request(`/api/integrations/${INTEGRATION}/auths/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a delegated credential reconnects rows scoped to its space only", () => {
  let bearer: Record<string, string>;

  beforeEach(async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:connect"],
    });
    bearer = { Authorization: `Bearer ${key.rawKey}` };
  });

  const reconnect = (connectionId: string, headers: Record<string, string>) =>
    post("api/connect/fields", headers, {
      credentials: { api_key: "new" },
      connection_id: connectionId,
    });

  // A reconnect targets a row of the door's own auth.
  const doors = [
    { path: "api/connect/fields", authKey: "api", body: { credentials: { api_key: "new" } } },
    { path: "api/connect/session", authKey: "api", body: {} },
    { path: "google/connect/oauth2", authKey: "google", body: {} },
  ] as const;
  const seedDoorRow = (door: (typeof doors)[number], spaceId: string | null) =>
    seedRow(door.authKey, spaceId, door.authKey === "google" ? SYSTEM_ID : undefined);

  /** The fields door writes the new secret; the other two mint a URL and write nothing yet. */
  const renewedBy = async (
    door: (typeof doors)[number],
    row: { id: string; credentialsEncrypted: string },
  ) =>
    ((await ciphertextOf(row.id)) !== row.credentialsEncrypted) ===
    (door.path === "api/connect/fields");

  const delegates: Record<
    string,
    () => { headers: Record<string, string>; through: Hono<AppEnv> }
  > = {
    "an API key, pinned to its space": () => ({ headers: bearer, through: app }),
    "a third-party token pinning no space": () => ({
      headers: { "x-test-delegate-org": ctx.orgId, "X-Space-Id": ctx.defaultSpaceId },
      through: delegateApp,
    }),
  };

  for (const [name, credential] of Object.entries(delegates)) {
    it(`refuses ${name} an org-scoped row at every reconnect door (403), and renews its space's row`, async () => {
      const { headers, through } = credential();
      for (const door of doors) {
        const orgRow = await seedDoorRow(door, null);
        const refused = await post(
          door.path,
          headers,
          { ...door.body, connection_id: orgRow.id },
          through,
        );
        expect([door.path, refused.status]).toEqual([door.path, 403]);
        expect(((await refused.json()) as { detail: string }).detail).toContain(
          "A delegated credential cannot reconnect a connection serving the whole organization",
        );
        expect(await ciphertextOf(orgRow.id)).toBe(orgRow.credentialsEncrypted);

        const spaceRow = await seedDoorRow(door, ctx.defaultSpaceId);
        const renewed = await post(
          door.path,
          headers,
          { ...door.body, connection_id: spaceRow.id },
          through,
        );
        expect([door.path, renewed.status]).toEqual([door.path, 200]);
        expect(await renewedBy(door, spaceRow)).toBe(true);
      }
    });
  }

  it("lets the owner's session reconnect an org-scoped row at every door", async () => {
    for (const door of doors) {
      const orgRow = await seedDoorRow(door, null);
      const res = await post(door.path, authHeaders(ctx), {
        ...door.body,
        connection_id: orgRow.id,
      });
      expect([door.path, res.status]).toEqual([door.path, 200]);
      expect(await renewedBy(door, orgRow)).toBe(true);
    }
  });

  it("lists, for an own org-scoped row, the share it may make: its own space only", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:read", "integrations:connect"],
    });
    const orgRow = await seedRow("api", null);
    const res = await app.request(`/api/integrations/${INTEGRATION}/connections`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        id: string;
        allowed_actions: string[];
        shareable_spaces?: { id: string; name: string }[];
      }[];
    };
    const row = data.find((entry) => entry.id === orgRow.id)!;
    expect(row.allowed_actions).toContain("share");
    expect(row.shareable_spaces?.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
  });

  it("renews a row scoped to its space", async () => {
    const spaceRow = await seedRow("api", ctx.defaultSpaceId);
    expect((await reconnect(spaceRow.id, bearer)).status).toBe(200);
    expect(await ciphertextOf(spaceRow.id)).not.toBe(spaceRow.credentialsEncrypted);
  });

  it("creates a row scoped to its space, where the owner's session creates one for the org", async () => {
    const create = (headers: Record<string, string>) =>
      post("api/connect/fields", headers, { credentials: { api_key: "k" } });

    const byKey = await create(bearer);
    expect(byKey.status).toBe(200);
    const keyRow = (await byKey.json()) as { id: string; scope: string };
    expect(keyRow.scope).toBe("space");
    expect(await scopeOf(keyRow.id)).toEqual({ spaceId: ctx.defaultSpaceId, originSpaceId: null });

    const bySession = await create(authHeaders(ctx));
    expect(bySession.status).toBe(200);
    expect(((await bySession.json()) as { scope: string }).scope).toBe("org");
  });

  it("renews a space row through a system client without widening it, unlike the owner's session", async () => {
    const spaceRow = await seedRow("google", ctx.defaultSpaceId, SYSTEM_ID);
    const renew = (delegated: boolean) =>
      saveIntegrationConnection(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        {
          packageId: INTEGRATION,
          authKey: "google",
          accountId: "default",
          credentials: { access_token: "new" },
          actor: { type: "user", id: ctx.user.id },
          connectionId: spaceRow.id,
          clientRef: SYSTEM_ID,
          ...(delegated ? { delegated: true } : {}),
        },
      );

    expect((await renew(true)).scope).toBe("space");
    expect(await scopeOf(spaceRow.id)).toEqual({
      spaceId: ctx.defaultSpaceId,
      originSpaceId: null,
    });
    expect((await renew(false)).scope).toBe("org");
    expect(await scopeOf(spaceRow.id)).toEqual({
      spaceId: null,
      originSpaceId: ctx.defaultSpaceId,
    });
  });

  it("carries the restriction through the OAuth state to the write", async () => {
    const spaceRow = await seedRow("google", ctx.defaultSpaceId, SYSTEM_ID);
    const res = await post("google/connect/oauth2", bearer, { connection_id: spaceRow.id });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    const record = await oauthStateStore.get(state);
    expect(record?.integration).toMatchObject({ connectionId: spaceRow.id, delegated: true });

    // The row serves the whole org by the time the callback writes.
    await db
      .update(integrationConnections)
      .set({ spaceId: null, originSpaceId: ctx.defaultSpaceId })
      .where(eq(integrationConnections.id, spaceRow.id));
    await expect(
      saveIntegrationConnection(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        {
          packageId: INTEGRATION,
          authKey: "google",
          accountId: "default",
          credentials: { access_token: "new" },
          actor: { type: "user", id: ctx.user.id },
          connectionId: spaceRow.id,
          clientRef: SYSTEM_ID,
          delegated: true,
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await ciphertextOf(spaceRow.id)).toBe(spaceRow.credentialsEncrypted);
  });
});

describe("an org-scoped row reconnects through an org or system client", () => {
  async function seedSpaceDefaultClient(): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        integrationId: INTEGRATION,
        authKey: "google",
        clientId: "space-client",
        clientSecretEncrypted: encryptCredentials({ client_secret: "s" }),
        isDefault: true,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  /** Begin the reconnect from the origin space and persist what its callback would. */
  async function reconnectFromOrigin(connectionId: string) {
    const res = await post("google/connect/oauth2", authHeaders(ctx), {
      connection_id: connectionId,
    });
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: string };
    const clientRef = (await oauthStateStore.get(state))!.integration!.clientRef;
    return saveIntegrationConnection(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        packageId: INTEGRATION,
        authKey: "google",
        accountId: "default",
        credentials: { access_token: "new" },
        actor: { type: "user", id: ctx.user.id },
        connectionId,
        clientRef,
      },
    );
  }

  it("skips the origin space's own default client and stays org-scoped", async () => {
    const orgRow = await seedRow("google", null, SYSTEM_ID);
    await seedSpaceDefaultClient();
    const summary = await reconnectFromOrigin(orgRow.id);
    expect(summary.scope).toBe("org");
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, orgRow.id));
    expect(row).toMatchObject({ spaceId: null, clientRef: SYSTEM_ID });
  });

  it("after 0041 widened a system-client row of a space that has its own client since", async () => {
    const legacy = await seedRow("google", ctx.defaultSpaceId, SYSTEM_ID);
    await seedSpaceDefaultClient();
    await runWidenConnectionsToOrgScope({ apply: true, out: () => {} });
    expect((await reconnectFromOrigin(legacy.id)).scope).toBe("org");
  });

  it("answers 409 connection_scope_narrowing when no org or system client exists", async () => {
    __resetSystemIntegrationsForTest();
    const orgRow = await seedRow("google", null);
    await seedSpaceDefaultClient();
    const res = await post("google/connect/oauth2", authHeaders(ctx), {
      connection_id: orgRow.id,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("connection_scope_narrowing");
  });
});
