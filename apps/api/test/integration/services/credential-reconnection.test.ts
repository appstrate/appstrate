// SPDX-License-Identifier: Apache-2.0

/** Every path flipping `needs_reconnection` announces once, never against a flagged row; the bell goes to an integration owner only. */

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
import {
  GMAIL_PACKAGE_ID,
  readCredentialRevision,
  readRefreshTarget,
  refreshOf,
  seedPinnedClient,
  seedRefreshConnection,
} from "../../helpers/refresh-fixtures.ts";
import {
  auditEvents,
  integrationConnections,
  modelProviderCredentials,
  notifications,
} from "@appstrate/db/schema";
import {
  markIntegrationConnectionNeedsReconnection,
  recordIntegrationRefreshFailure,
  recordUnrefreshableRejection,
  saveIntegrationConnection,
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

  const seedConnection = (
    opts: Parameters<typeof seedRefreshConnection>[2] & { clientRef?: string | null } = {},
  ) =>
    seedRefreshConnection(ctx, opts.clientRef === undefined ? clientId : opts.clientRef, {
      label: "Pierre Gmail",
      ...opts,
    });

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

  describe("the death record", () => {
    const readDeath = async (id: string) =>
      (
        await db
          .select({
            flagged: integrationConnections.needsReconnection,
            cause: integrationConnections.needsReconnectionCause,
            at: integrationConnections.needsReconnectionAt,
          })
          .from(integrationConnections)
          .where(eq(integrationConnections.id, id))
      )[0]!;
    const deathAudits = async (id: string) =>
      db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));

    it.each(deaths)(
      "$cause keeps its cause and date, and is audited once by the system",
      async (death) => {
        const connId = await seedConnection(death.seed);
        await death.flip(connId);
        await death.flip(connId);
        await until(async () => (await deathAudits(connId)).length >= 1);
        await settle();

        const row = await readDeath(connId);
        expect(row.flagged).toBe(true);
        expect(row.cause).toBe(death.cause);
        expect(row.at).toBeInstanceOf(Date);
        const audits = await deathAudits(connId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          actorType: "system",
          actorId: null,
          action: "integration.connection.needs_reconnection",
          resourceType: "integration_connection",
          after: { cause: death.cause },
        });
      },
    );

    it("the escalation records its cause in the flipping statement, and a later failure keeps it", async () => {
      const connId = await seedConnection({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) });
      for (let i = 0; i < 3; i++)
        await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });
      const first = await readDeath(connId);
      expect(first.cause).toBe("refresh_failures_exhausted");

      await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });
      expect(await readDeath(connId)).toEqual(first);
    });

    it("an unrefreshable rejection streak records `unrefreshable`", async () => {
      const connId = await seedConnection({ clientRef: null });
      const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
      const revision = (await readCredentialRevision(connId))!;
      for (let i = 0; i < max; i++)
        await recordUnrefreshableRejection(connId, GMAIL_PACKAGE_ID, reach(), revision, max);
      expect((await readDeath(connId)).cause).toBe("unrefreshable");
    });

    it("a reconnect clears the flag, the cause and the date in the same write", async () => {
      const connId = await seedConnection();
      await markIntegrationConnectionNeedsReconnection(connId, "refresh_token_revoked");
      expect((await readDeath(connId)).cause).toBe("refresh_token_revoked");
      const [row] = await db
        .select({ accountId: integrationConnections.accountId })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      const accountId = row!.accountId;

      await saveIntegrationConnection(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        {
          packageId: GMAIL_PACKAGE_ID,
          authKey: "primary",
          accountId,
          credentials: { access_token: "new", refresh_token: "new-rt" },
          actor: { type: "user", id: ctx.user.id },
          connectionId: connId,
          clientRef: clientId,
        },
      );
      expect(await readDeath(connId)).toEqual({ flagged: false, cause: null, at: null });
    });

    it("the database refuses a cause or a date on a row that is not flagged", async () => {
      const connId = await seedConnection();
      const write = async () => {
        await db
          .update(integrationConnections)
          .set({ needsReconnectionCause: "unrefreshable" })
          .where(eq(integrationConnections.id, connId));
      };
      await expect(write()).rejects.toThrow();
    });
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

  it("keeps the cause and date in the row and audits the flip once, as the system", async () => {
    const cred = await seedOrgModelProviderOAuth({ orgId: ctx.orgId });
    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "refresh_token_revoked");
    await markCredentialNeedsReconnection(ctx.orgId, cred.id, "unrefreshable");
    await until(async () => (await db.select().from(auditEvents)).length >= 1);
    await settle();

    const [row] = await db
      .select({
        flagged: modelProviderCredentials.needsReconnection,
        cause: modelProviderCredentials.needsReconnectionCause,
        at: modelProviderCredentials.needsReconnectionAt,
      })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, cred.id));
    expect(row).toMatchObject({ flagged: true, cause: "refresh_token_revoked" });
    expect(row!.at).toBeInstanceOf(Date);
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, cred.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      orgId: ctx.orgId,
      actorType: "system",
      action: "model_provider_credential.needs_reconnection",
      resourceType: "model_provider_credential",
      after: { cause: "refresh_token_revoked" },
    });
  });

  it("an api key rejected too often records `unrefreshable` in the row", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      apiKey: "sk-dead",
    });
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 0; i < max; i++)
      await recordModelCredentialRejection(ctx.orgId, cred.id, "sk-dead");
    const [row] = await db
      .select({
        flagged: modelProviderCredentials.needsReconnection,
        cause: modelProviderCredentials.needsReconnectionCause,
      })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, cred.id));
    expect(row).toEqual({ flagged: true, cause: "unrefreshable" });
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
