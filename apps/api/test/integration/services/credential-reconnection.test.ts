// SPDX-License-Identifier: Apache-2.0

/**
 * The announcement of a credential's death: every path that flips `needs_reconnection` from false
 * to true announces exactly once, through `onCredentialNeedsReconnection`, and no path announces
 * again against a row already flagged. An integration connection's owner also gets a bell row
 * (in the connection's space, else the space it was connected from, else the owner's personal
 * space); a model-provider credential writes none.
 *
 * A module registered through `loadModulesFromInstances` records the event; the announcement is
 * fire-and-forget, so each assertion polls. A controllable Bun.serve stands in for the token
 * endpoint of the driver-level paths.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedEndUser,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedPackage,
  seedSpace,
} from "../../helpers/seed.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import {
  integrationConnections,
  integrationOauthClients,
  modelProviderCredentials,
  notifications,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AppstrateModule, CredentialNeedsReconnectionParams } from "@appstrate/core/module";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import {
  refreshConnectionCredential,
  type RefreshTarget,
} from "../../../src/services/integration-token-refresh.ts";
import {
  markIntegrationConnectionNeedsReconnection,
  readCredentialRevision,
  recordIntegrationRefreshFailure,
  recordUnrefreshableRejection,
} from "../../../src/services/integration-connections.ts";
import {
  markCredentialNeedsReconnection,
  recordModelCredentialRefreshFailure,
  recordModelCredentialRejection,
} from "../../../src/services/model-providers/credentials.ts";
import { getEnv } from "@appstrate/env";

const PACKAGE_ID = "@official/gmail";
const HOUR_MS = 3_600_000;

// ─── The event listener ─────────────────────────────────────

const announced: CredentialNeedsReconnectionParams[] = [];

async function installListener(): Promise<void> {
  announced.length = 0;
  resetModules();
  const mod: AppstrateModule = {
    manifest: { id: "death-spy", name: "Death Spy", version: "1.0.0" },
    async init() {},
    events: { onCredentialNeedsReconnection: (params) => void announced.push(params) },
  };
  await loadModulesFromInstances([mod], {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => async () => {},
    getOrgOwnerEmails: async () => [],
    getOrgMembers: async () => [],
    getOrgName: async () => null,
    services: {} as never,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds (the announcement is fire-and-forget). */
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("announcement never arrived");
}

/** A second call against a flagged row announces nothing: give a stray announcement time to land. */
async function settle(): Promise<void> {
  await sleep(250);
}

// ─── Token endpoint ─────────────────────────────────────────

function startTokenServer(): {
  url: string;
  respond: (body: object, status?: number) => void;
  stop: () => void;
} {
  let body: object = {};
  let status = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  });
  return {
    url: `http://${server.hostname}:${server.port}/token`,
    respond: (b, s = 200) => {
      body = b;
      status = s;
    },
    stop: () => void server.stop(),
  };
}

function gmailManifest(tokenUrl: string): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: PACKAGE_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: {
      kind: "local",
      server: {
        type: "node",
        entry_point: "server/index.js",
        mcp_config: { command: "node", args: ["server/index.js"] },
      },
    },
    auths: {
      primary: {
        type: "oauth2",
        authorization_endpoint: "https://idp/a",
        token_endpoint: tokenUrl,
        authorized_uris: ["https://api/*"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

// ─── Integration connections ────────────────────────────────

describe("integration connection death", () => {
  let ctx: TestContext;
  let token: ReturnType<typeof startTokenServer>;
  let clientId: string;

  beforeEach(async () => {
    await truncateAll();
    await installListener();
    ctx = await createTestContext({ orgSlug: "death" });
    token = startTokenServer();
    await seedPackage({
      id: PACKAGE_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(token.url) as unknown as Record<string, unknown>,
    });
    const [client] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        integrationId: PACKAGE_ID,
        authKey: "primary",
        clientId: "cid",
        clientSecretEncrypted: encryptCredentials({ client_secret: "csec" }),
      })
      .returning({ id: integrationOauthClients.id });
    clientId = client!.id;
  });

  afterEach(() => token.stop());
  afterAll(async () => restoreDiscoveredModules());

  async function seedConnection(
    opts: {
      refreshToken?: string;
      expiresAt?: Date;
      spaceId?: string | null;
      originSpaceId?: string | null;
      endUserId?: string;
      clientRef?: string | null;
    } = {},
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: PACKAGE_ID,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID()}`,
        label: "Pierre Gmail",
        orgId: ctx.orgId,
        spaceId: opts.spaceId === undefined ? ctx.defaultSpaceId : opts.spaceId,
        originSpaceId: opts.originSpaceId ?? null,
        ...(opts.endUserId ? { endUserId: opts.endUserId } : { userId: ctx.user.id }),
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: {
            access_token: "old-access",
            ...(opts.refreshToken === "" ? {} : { refresh_token: opts.refreshToken ?? "rt-1" }),
          },
        }),
        clientRef: opts.clientRef === undefined ? clientId : opts.clientRef,
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /** The driver: `refreshConnectionCredential` as a rejected call asks for it. */
  async function drive(connId: string) {
    const [row] = await db
      .select({
        id: integrationConnections.id,
        orgId: integrationConnections.orgId,
        spaceId: integrationConnections.spaceId,
        credentialsEncrypted: integrationConnections.credentialsEncrypted,
        clientRef: integrationConnections.clientRef,
        oauthResource: integrationConnections.oauthResource,
        expiresAt: integrationConnections.expiresAt,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    const target: RefreshTarget & { expiresAt: Date | null; credentialRevision: string } = {
      ...row!,
      credentialRevision: (await readCredentialRevision(connId))!,
    };
    return refreshConnectionCredential({
      connection: { ...target, authKey: "primary" },
      integrationId: PACKAGE_ID,
      manifest: gmailManifest(token.url),
      authDef: gmailManifest(token.url).auths!.primary as AfpsManifestAuth,
      trigger: {
        kind: "rejected",
        revision: null,
        reach: { spaceId: ctx.defaultSpaceId, actor: { type: "user", id: ctx.user.id } },
      },
    });
  }

  const bellRows = () =>
    db.select().from(notifications).where(eq(notifications.type, "credential_needs_reconnection"));

  it("a revoked refresh token announces once; a second refresh of the flagged row announces nothing", async () => {
    const connId = await seedConnection();
    token.respond({ error: "invalid_grant" }, 400);

    expect(await drive(connId)).toMatchObject({ status: "dead", cause: "refresh_token_revoked" });
    await until(() => announced.length === 1);
    expect(announced[0]).toEqual({
      kind: "integration_connection",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId: connId,
      integrationId: PACKAGE_ID,
      authKey: "primary",
      owner: { type: "user", id: ctx.user.id },
      cause: "refresh_token_revoked",
    });

    await drive(connId);
    await settle();
    expect(announced).toHaveLength(1);
  });

  it("a connection without a refresh token announces once, with refresh_token_missing", async () => {
    const connId = await seedConnection({ refreshToken: "" });

    expect(await drive(connId)).toMatchObject({ status: "dead", cause: "refresh_token_missing" });
    await until(() => announced.length === 1);
    expect(announced[0]).toMatchObject({ cause: "refresh_token_missing", connectionId: connId });

    await drive(connId);
    await settle();
    expect(announced).toHaveLength(1);
  });

  it("an undecryptable credential announces once, with credentials_undecryptable", async () => {
    const connId = await seedConnection();
    await markIntegrationConnectionNeedsReconnection(connId, "credentials_undecryptable");
    await markIntegrationConnectionNeedsReconnection(connId, "credentials_undecryptable");

    await until(() => announced.length === 1);
    await settle();
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ cause: "credentials_undecryptable" });
  });

  it("the transient-failure escalation announces on the failure that flips, never before or after", async () => {
    const connId = await seedConnection({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) });
    const failure = () => recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });

    expect(await failure()).toEqual({ failures: 1, needsReconnection: false });
    expect(await failure()).toEqual({ failures: 2, needsReconnection: false });
    await settle();
    expect(announced).toHaveLength(0);

    expect(await failure()).toEqual({ failures: 3, needsReconnection: true });
    await until(() => announced.length === 1);
    expect(announced[0]).toMatchObject({ cause: "refresh_failures_exhausted" });

    expect(await failure()).toEqual({ failures: 4, needsReconnection: true });
    await settle();
    expect(announced).toHaveLength(1);
  });

  it("concurrent failures crossing the threshold announce exactly once", async () => {
    const connId = await seedConnection({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 }),
      ),
    );
    await until(() => announced.length >= 1);
    await settle();
    expect(announced).toHaveLength(1);
  });

  it("a rejection streak on an unrefreshable credential announces with `unrefreshable`", async () => {
    const connId = await seedConnection({ clientRef: null });
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    const revision = (await readCredentialRevision(connId))!;
    const reach = {
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
    } as const;
    const reject = () => recordUnrefreshableRejection(connId, PACKAGE_ID, reach, revision, max);

    for (let i = 0; i < max - 1; i++) await reject();
    await settle();
    expect(announced).toHaveLength(0);

    expect(await reject()).toMatchObject({ needsReconnection: true });
    await until(() => announced.length === 1);
    expect(announced[0]).toMatchObject({ cause: "unrefreshable" });

    await reject();
    await settle();
    expect(announced).toHaveLength(1);
  });

  describe("the bell row", () => {
    it("lands for the owner in the connection's space", async () => {
      const connId = await seedConnection();
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");

      await until(async () => (await bellRows()).length === 1);
      const [row] = await bellRows();
      expect(row).toMatchObject({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        recipientType: "user",
        recipientId: ctx.user.id,
        runId: null,
        payload: {
          kind: "integration_connection",
          packageId: PACKAGE_ID,
          integration_name: "Gmail",
          connection_id: connId,
          label: "Pierre Gmail",
          auth_key: "primary",
          cause: "refresh_token_revoked",
        },
      });
    });

    it("lands in the space an org-level connection was connected from", async () => {
      const origin = await seedSpace({ orgId: ctx.orgId, name: "Origin" });
      const connId = await seedConnection({ spaceId: null, originSpaceId: origin.id });
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");

      await until(async () => (await bellRows()).length === 1);
      expect((await bellRows())[0]).toMatchObject({ spaceId: origin.id, recipientId: ctx.user.id });
      expect(announced[0]).toMatchObject({ spaceId: null });
    });

    it("falls back to the owner's personal space for an org-level connection with no origin", async () => {
      const personal = await seedSpace({
        orgId: ctx.orgId,
        name: "Personal",
        ownerUserId: ctx.user.id,
        visibility: "private",
      });
      const connId = await seedConnection({ spaceId: null });
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");

      await until(async () => (await bellRows()).length === 1);
      expect((await bellRows())[0]).toMatchObject({ spaceId: personal.id });
    });

    it("writes no row, and still emits the event, when the owner has no space to be told in", async () => {
      const connId = await seedConnection({ spaceId: null });
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");

      await until(() => announced.length === 1);
      await settle();
      expect(await bellRows()).toHaveLength(0);
    });

    it("reaches an end-user owner in the connection's space", async () => {
      const endUser = await seedEndUser({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        externalId: "eu-ext-1",
      });
      const connId = await seedConnection({ endUserId: endUser.id });
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");

      await until(async () => (await bellRows()).length === 1);
      expect((await bellRows())[0]).toMatchObject({
        recipientType: "end_user",
        recipientId: endUser.id,
        spaceId: ctx.defaultSpaceId,
      });
      expect(announced[0]).toMatchObject({ owner: { type: "end_user", id: endUser.id } });
    });
  });
});

// ─── Model-provider credentials ─────────────────────────────

describe("model-provider credential death", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await installListener();
    ctx = await createTestContext({ orgSlug: "model-death" });
  });

  afterAll(async () => restoreDiscoveredModules());

  const bellCount = async () =>
    (await db.select().from(notifications).where(eq(notifications.orgId, ctx.orgId))).length;

  it("a revoked refresh token announces once and writes no bell row", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.orgId });
    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "refresh_token_revoked");

    await until(() => announced.length === 1);
    expect(announced[0]).toEqual({
      kind: "model_provider_credential",
      orgId: ctx.orgId,
      credentialId: cred.id,
      providerId: "test-oauth",
      cause: "refresh_token_revoked",
    });

    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "refresh_token_revoked");
    await settle();
    expect(announced).toHaveLength(1);
    expect(await bellCount()).toBe(0);
  });

  it("the transient-failure escalation announces on the flipping failure only", async () => {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      expiresAt: Date.now() - 2 * HOUR_MS,
    });
    // The denormalized expiry the escalation gate reads.
    await db
      .update(modelProviderCredentials)
      .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(eq(modelProviderCredentials.id, cred.id));
    const failure = () => recordModelCredentialRefreshFailure(ctx.orgId, cred.id, 2, 3600);

    expect(await failure()).toEqual({ failures: 1, needsReconnection: false });
    await settle();
    expect(announced).toHaveLength(0);

    expect(await failure()).toEqual({ failures: 2, needsReconnection: true });
    await until(() => announced.length === 1);
    expect(announced[0]).toMatchObject({
      kind: "model_provider_credential",
      cause: "refresh_failures_exhausted",
    });

    await failure();
    await settle();
    expect(announced).toHaveLength(1);
    expect(await bellCount()).toBe(0);
  });

  it("an api key rejected INTEGRATION_REFRESH_MAX_FAILURES times announces once, with `unrefreshable`", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      apiKey: "sk-dead",
    });
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 0; i < max - 1; i++)
      await recordModelCredentialRejection(ctx.orgId, cred.id, "sk-dead");
    await settle();
    expect(announced).toHaveLength(0);

    await recordModelCredentialRejection(ctx.orgId, cred.id, "sk-dead");
    await until(() => announced.length === 1);
    expect(announced[0]).toMatchObject({
      kind: "model_provider_credential",
      credentialId: cred.id,
      providerId: "openai",
      cause: "unrefreshable",
    });

    await recordModelCredentialRejection(ctx.orgId, cred.id, "sk-dead");
    await settle();
    expect(announced).toHaveLength(1);
  });
});
