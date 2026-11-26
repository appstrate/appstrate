// SPDX-License-Identifier: Apache-2.0

/**
 * The announcement of a credential's death: every path that flips `needs_reconnection` from false
 * to true announces exactly once, through `onCredentialNeedsReconnection`, and no path announces
 * again against a row already flagged. An integration connection's owner also gets a bell row
 * (in the connection's space, else the space it was connected from, else the owner's personal
 * space); a model-provider credential writes none.
 *
 * The announcement is fire-and-forget (`credential-death-spy`), so each assertion polls and each
 * test settles once, after its last write, before asserting nothing more arrived.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedEndUser,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedSpace,
} from "../../helpers/seed.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import { announced, installDeathSpy, settle, until } from "../../helpers/credential-death-spy.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";
import { readCredentialRevision } from "../../helpers/credential-revision.ts";
import {
  GMAIL_PACKAGE_ID,
  readRefreshTarget,
  refreshOf,
  seedPinnedClient,
} from "../../helpers/refresh-fixtures.ts";
import { integrationConnections, notifications } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  markIntegrationConnectionNeedsReconnection,
  recordIntegrationRefreshFailure,
  recordUnrefreshableRejection,
} from "../../../src/services/integration-connections.ts";
import {
  markCredentialNeedsReconnection,
  recordModelCredentialRefreshFailure,
  recordModelCredentialRejection,
} from "../../../src/services/model-providers/credentials.ts";
import { getEnv } from "@appstrate/env";

const HOUR_MS = 3_600_000;

// ─── Integration connections ────────────────────────────────

describe("integration connection death", () => {
  let ctx: TestContext;
  let oauth: MockOAuthServer;
  let tokenUrl: string;
  let clientId: string;

  beforeEach(async () => {
    await truncateAll();
    await installDeathSpy();
    ctx = await createTestContext({ orgSlug: "death" });
    oauth = createMockOAuthServer();
    tokenUrl = `${oauth.url}/token`;
    clientId = await seedPinnedClient(ctx, tokenUrl);
  });

  afterEach(() => oauth.stop());
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
        integrationId: GMAIL_PACKAGE_ID,
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

  const reach = () =>
    ({ spaceId: ctx.defaultSpaceId, actor: { type: "user", id: ctx.user.id } }) as const;

  /** `refreshConnectionCredential` as an upstream rejection asks for it. */
  async function drive(connId: string) {
    return refreshOf(await readRefreshTarget(connId), tokenUrl, {
      kind: "rejected",
      revision: null,
      reach: reach(),
    });
  }

  const bellRows = () =>
    db.select().from(notifications).where(eq(notifications.type, "credential_needs_reconnection"));

  // The three causes share one flip point (`markIntegrationConnectionNeedsReconnection`):
  // one announcement, however often the flagged row is hit again.
  const deaths = [
    {
      cause: "refresh_token_revoked",
      seed: {},
      flip: async (id: string) => {
        oauth.setTokenStatus(400);
        oauth.setTokenResponse({ error: "invalid_grant" });
        await drive(id);
      },
    },
    {
      cause: "refresh_token_missing",
      seed: { refreshToken: "" },
      flip: async (id: string) => {
        await drive(id);
      },
    },
    {
      cause: "credentials_undecryptable",
      seed: {},
      flip: (id: string) =>
        markIntegrationConnectionNeedsReconnection(id, "credentials_undecryptable"),
    },
  ] as const;

  it.each(deaths)(
    "$cause announces once, however often the flagged row is hit again",
    async (death) => {
      const connId = await seedConnection(death.seed);

      await death.flip(connId);
      await until(() => announced.length === 1);
      await death.flip(connId);
      await settle();

      expect(announced).toEqual([
        {
          kind: "integration_connection",
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          connectionId: connId,
          packageId: GMAIL_PACKAGE_ID,
          authKey: "primary",
          owner: { type: "user", id: ctx.user.id },
          cause: death.cause,
        },
      ]);
    },
  );

  it("the transient-failure escalation announces on the failure that flips, never before or after", async () => {
    const connId = await seedConnection({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) });
    const failure = () => recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });

    expect(await failure()).toEqual({ failures: 1, needsReconnection: false });
    expect(await failure()).toEqual({ failures: 2, needsReconnection: false });
    expect(await failure()).toEqual({ failures: 3, needsReconnection: true });
    await until(() => announced.length === 1);
    expect(await failure()).toEqual({ failures: 4, needsReconnection: true });
    await settle();

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ cause: "refresh_failures_exhausted" });
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
    const reject = () =>
      recordUnrefreshableRejection(connId, GMAIL_PACKAGE_ID, reach(), revision, max);

    for (let i = 0; i < max - 1; i++) await reject();
    expect(await reject()).toMatchObject({ needsReconnection: true });
    await until(() => announced.length === 1);
    await reject();
    await settle();

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ cause: "unrefreshable" });
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
      });
      expect(row!.payload).toEqual({
        packageId: GMAIL_PACKAGE_ID,
        integration_name: "Gmail",
        label: "Pierre Gmail",
        cause: "refresh_token_revoked",
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
    await installDeathSpy();
    ctx = await createTestContext({ orgSlug: "model-death" });
  });

  afterAll(async () => restoreDiscoveredModules());

  const bellCount = async () =>
    (await db.select().from(notifications).where(eq(notifications.orgId, ctx.orgId))).length;

  it("a revoked refresh token announces once and writes no bell row", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.orgId });
    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "refresh_token_revoked");
    await until(() => announced.length === 1);
    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "refresh_token_revoked");
    await settle();

    expect(announced).toEqual([
      {
        kind: "model_provider_credential",
        orgId: ctx.orgId,
        credentialId: cred.id,
        providerId: "test-oauth",
        cause: "refresh_token_revoked",
      },
    ]);
    expect(await bellCount()).toBe(0);
  });

  it("the transient-failure escalation announces on the flipping failure only", async () => {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      expiresAt: Date.now() - 2 * HOUR_MS,
    });
    const failure = () => recordModelCredentialRefreshFailure(ctx.orgId, cred.id, 2, 3600);

    expect(await failure()).toEqual({ failures: 1, needsReconnection: false });
    expect(await failure()).toEqual({ failures: 2, needsReconnection: true });
    await until(() => announced.length === 1);
    await failure();
    await settle();

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      kind: "model_provider_credential",
      cause: "refresh_failures_exhausted",
    });
    expect(await bellCount()).toBe(0);
  });

  it("an api key rejected INTEGRATION_REFRESH_MAX_FAILURES times announces once, with `unrefreshable`", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      apiKey: "sk-dead",
    });
    const reject = () => recordModelCredentialRejection(ctx.orgId, cred.id, "sk-dead");
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;

    for (let i = 0; i < max; i++) await reject();
    await until(() => announced.length === 1);
    await reject();
    await settle();

    expect(announced).toEqual([
      {
        kind: "model_provider_credential",
        orgId: ctx.orgId,
        credentialId: cred.id,
        providerId: "openai",
        cause: "unrefreshable",
      },
    ]);
  });
});
