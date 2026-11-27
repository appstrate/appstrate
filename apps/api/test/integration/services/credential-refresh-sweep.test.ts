// SPDX-License-Identifier: Apache-2.0

/** The credential refresh sweep: which rows a scan claims, and what refreshing a claimed row does. */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { decryptCredentialsToStringMap, encryptCredentials } from "@appstrate/connect";
import {
  integrationConnections,
  integrationOauthClients,
  modelProviderCredentials,
} from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth, seedPublishedVersion } from "../../helpers/seed.ts";
import {
  GMAIL_PACKAGE_ID,
  seedPinnedClient,
  seedRefreshConnection,
} from "../../helpers/refresh-fixtures.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import { announced, installDeathSpy, settle, until } from "../../helpers/credential-death-spy.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { createMockOAuthServer } from "../../helpers/oauth-server.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import {
  scanCredentialRefreshes,
  shutdownCredentialRefreshSweep,
} from "../../../src/services/credential-refresh-sweep.ts";

const HOUR = 60 * 60_000;

const originalFetch = globalThis.fetch;
const mockServer = createMockOAuthServer();

afterAll(async () => {
  mockServer.stop();
  await shutdownCredentialRefreshSweep();
  await restoreDiscoveredModules();
});

// ─── integration connections ────────────────────────────────

describe("credential refresh sweep — integration connections", () => {
  let ctx: TestContext;
  let clientId: string;

  async function seedConnection(opts: {
    /** Relative to now; `null` = no expiry. */
    expiresInMs: number | null;
    /** How long ago the sweep or a write last visited it; `null` = never. */
    visitedAgoMs?: number | null;
    needsReconnection?: boolean;
    /** `false`: a non-OAuth2 row. */
    oauth?: boolean;
    /** `null`: an org-level connection. */
    spaceId?: string | null;
    clientRef?: string;
    authKey?: string;
  }): Promise<string> {
    return seedRefreshConnection(ctx, opts.oauth === false ? null : (opts.clientRef ?? clientId), {
      refreshToken: "rt_old",
      scopesGranted: ["openid"],
      spaceId: opts.spaceId,
      authKey: opts.authKey,
      needsReconnection: opts.needsReconnection,
      expiresAt: opts.expiresInMs === null ? null : new Date(Date.now() + opts.expiresInMs),
      refreshCheckedAt: opts.visitedAgoMs == null ? null : new Date(Date.now() - opts.visitedAgoMs),
    });
  }

  async function readRow(id: string) {
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return row!;
  }

  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenStatus(200);
    mockServer.setTokenResponse({
      access_token: "fresh_token",
      refresh_token: "rt_rotated",
      token_type: "Bearer",
      expires_in: 3600,
    });
    ctx = await createTestContext({ orgSlug: "sweeporg" });
    clientId = await seedPinnedClient(ctx, `${mockServer.url}/token`);
  });

  const publish = () => seedPublishedVersion(GMAIL_PACKAGE_ID, "1.0.0");

  const claimedIntegrations = async () => (await scanCredentialRefreshes()).integrations;

  describe("due predicate", () => {
    it("claims an expired row that was never visited", async () => {
      await seedConnection({ expiresInMs: -HOUR });
      expect(await claimedIntegrations()).toBe(1);
    });

    it("claims a row expiring within the lead that was visited more than a day ago", async () => {
      await seedConnection({ expiresInMs: 60_000, visitedAgoMs: 25 * HOUR });
      expect(await claimedIntegrations()).toBe(1);
    });

    it("skips a row visited within the day, valid beyond the lead, or with no expiry", async () => {
      await seedConnection({ expiresInMs: -HOUR, visitedAgoMs: HOUR });
      await seedConnection({ expiresInMs: 10 * 60_000 });
      await seedConnection({ expiresInMs: null });
      expect(await claimedIntegrations()).toBe(0);
    });

    it("skips a flagged row and a non-OAuth2 row", async () => {
      await seedConnection({ expiresInMs: -HOUR, needsReconnection: true });
      await seedConnection({ expiresInMs: -HOUR, oauth: false });
      expect(await claimedIntegrations()).toBe(0);
    });
  });

  describe("claim", () => {
    it("stamps the visit, so a second scan right after claims nothing", async () => {
      const id = await seedConnection({ expiresInMs: -HOUR });

      expect(await claimedIntegrations()).toBe(1);
      expect((await readRow(id)).refreshCheckedAt).not.toBeNull();
      expect(await claimedIntegrations()).toBe(0);
    });

    it("never hands the same row to two concurrent scans", async () => {
      for (let i = 0; i < 5; i++) await seedConnection({ expiresInMs: -HOUR });

      const [a, b] = await Promise.all([scanCredentialRefreshes(), scanCredentialRefreshes()]);

      expect(a.integrations + b.integrations).toBe(5);
    });
  });

  describe("refresh", () => {
    it("performs one exchange with the stored refresh token and persists the result", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });

      await scanCredentialRefreshes();

      expect(mockServer.tokenRequests()).toHaveLength(1);
      expect(new URLSearchParams(mockServer.tokenRequests()[0]!.body).get("refresh_token")).toBe(
        "rt_old",
      );
      expect(decryptCredentialsToStringMap((await readRow(id)).credentialsEncrypted)).toMatchObject(
        { access_token: "fresh_token" },
      );
    });

    it("refreshes an org-level connection (no space)", async () => {
      await publish();
      // An org-level connection pins an org-level client.
      const [orgClient] = await db
        .insert(integrationOauthClients)
        .values({
          orgId: ctx.orgId,
          spaceId: null,
          integrationId: GMAIL_PACKAGE_ID,
          authKey: "primary",
          clientId: "org_cid",
          clientSecretEncrypted: encryptCredentials({ client_secret: "org_csec" }),
        })
        .returning({ id: integrationOauthClients.id });
      const id = await seedConnection({
        expiresInMs: -HOUR,
        spaceId: null,
        clientRef: orgClient!.id,
      });

      await scanCredentialRefreshes();

      expect(mockServer.tokenRequests()).toHaveLength(1);
      expect(decryptCredentialsToStringMap((await readRow(id)).credentialsEncrypted)).toMatchObject(
        { access_token: "fresh_token" },
      );
    });

    it("counts a transient failure and does not claim the row again", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });
      mockServer.setTokenStatus(503);
      mockServer.setTokenResponse({ error: "temporarily_unavailable" });

      expect(await claimedIntegrations()).toBe(1);

      expect((await readRow(id)).refreshFailureCount).toBe(1);
      expect(await claimedIntegrations()).toBe(0);
    });

    it("flags the row on invalid_grant and takes it out of the due set", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({ error: "invalid_grant" });

      await scanCredentialRefreshes();

      expect((await readRow(id)).needsReconnection).toBe(true);
      // Even a visit older than a day does not bring a flagged row back.
      await db
        .update(integrationConnections)
        .set({ refreshCheckedAt: null })
        .where(eq(integrationConnections.id, id));
      expect(await claimedIntegrations()).toBe(0);
    });

    it("refreshes a connection of an integration with no published version, from its draft", async () => {
      const id = await seedConnection({ expiresInMs: -HOUR });

      await scanCredentialRefreshes();

      expect(mockServer.tokenRequests()).toHaveLength(1);
      expect(decryptCredentialsToStringMap((await readRow(id)).credentialsEncrypted)).toMatchObject(
        { access_token: "fresh_token" },
      );
    });

    it.each([
      {
        why: "an auth the published manifest no longer declares",
        publishFirst: true,
        authKey: "gone",
      },
      { why: "an auth the draft does not declare", publishFirst: false, authKey: "gone" },
    ])("leaves the row untouched for $why", async ({ publishFirst, authKey }) => {
      if (publishFirst) await publish();
      const id = await seedConnection({ expiresInMs: -HOUR, authKey });
      const before = await readRow(id);

      expect(await claimedIntegrations()).toBe(1);

      expect(mockServer.tokenRequests()).toHaveLength(0);
      const after = await readRow(id);
      expect(after.credentialsEncrypted).toBe(before.credentialsEncrypted);
      expect(after.refreshFailureCount).toBe(0);
      expect(after.needsReconnection).toBe(false);
    });
  });
});

// ─── model provider credentials ─────────────────────────────

describe("credential refresh sweep — model provider credentials", () => {
  let ctx: TestContext;
  let exchanges: number;
  /** The token endpoint's next answer. */
  let tokenAnswer: { status: number; body: object };

  async function seedOAuth(opts: {
    expiresInMs: number | null;
    visitedAgoMs?: number | null;
    flagged?: boolean;
    refreshToken?: string;
  }): Promise<string> {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      refreshToken: opts.refreshToken ?? "rt-old",
      expiresAt: opts.expiresInMs === null ? null : Date.now() + opts.expiresInMs,
      needsReconnection: opts.flagged ?? false,
    });
    if (opts.visitedAgoMs != null) {
      await db
        .update(modelProviderCredentials)
        .set({ refreshCheckedAt: new Date(Date.now() - opts.visitedAgoMs) })
        .where(eq(modelProviderCredentials.id, cred.id));
    }
    return cred.id;
  }

  async function readRow(id: string) {
    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    return row!;
  }

  beforeEach(async () => {
    await truncateAll();
    await installDeathSpy();
    seedTestModelProviders();
    ctx = await createTestContext({ orgSlug: "sweeporg" });
    exchanges = 0;
    tokenAnswer = {
      status: 200,
      body: {
        access_token: "new-access",
        refresh_token: "rt-new",
        token_type: "Bearer",
        expires_in: 3600,
      },
    };
    globalThis.fetch = (async () => {
      exchanges += 1;
      return new Response(JSON.stringify(tokenAnswer.body), {
        status: tokenAnswer.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const claimedModels = async () => (await scanCredentialRefreshes()).models;

  it("claims an expired never-visited credential and one expiring within the lead", async () => {
    await seedOAuth({ expiresInMs: -HOUR });
    await seedOAuth({ expiresInMs: 60_000, visitedAgoMs: 25 * HOUR });
    expect(await claimedModels()).toBe(2);
  });

  it("skips a credential visited within the day, valid beyond the lead, flagged, or with no expiry", async () => {
    await seedOAuth({ expiresInMs: -HOUR, visitedAgoMs: HOUR });
    await seedOAuth({ expiresInMs: 10 * 60_000 });
    await seedOAuth({ expiresInMs: null });
    await seedOAuth({ expiresInMs: -HOUR, flagged: true });
    expect(await claimedModels()).toBe(0);
  });

  it("skips an API-key credential", async () => {
    await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      ownerUserId: null,
      label: "api key",
      providerId: "test-apikey",
      apiKey: "sk-test",
    });
    await db
      .update(modelProviderCredentials)
      .set({ refreshCheckedAt: null, expiresAt: new Date(Date.now() - HOUR) })
      .where(inArray(modelProviderCredentials.providerId, ["test-apikey"]));
    expect(await claimedModels()).toBe(0);
  });

  it("stamps the visit and exchanges once, so a second scan claims nothing", async () => {
    await seedOAuth({ expiresInMs: -HOUR });
    expect(await claimedModels()).toBe(1);
    expect(exchanges).toBe(1);
    expect(await claimedModels()).toBe(0);
  });

  it("survives a failed exchange and leaves the credential usable", async () => {
    const id = await seedOAuth({ expiresInMs: -HOUR });
    tokenAnswer = { status: 503, body: { error: "temporarily_unavailable" } };

    await scanCredentialRefreshes();

    expect((await readRow(id)).needsReconnection).toBe(false);
  });

  // The refresh that ends dead: flagged, announced once, and out of the due set for good.
  it.each([
    {
      cause: "refresh_token_revoked",
      refreshToken: "rt-old",
      answer: { status: 400, body: { error: "invalid_grant" } },
      exchanged: 1,
    },
    { cause: "refresh_token_missing", refreshToken: "", answer: null, exchanged: 0 },
  ])("a refresh ending in $cause flags and announces the credential once", async (death) => {
    const id = await seedOAuth({ expiresInMs: -HOUR, refreshToken: death.refreshToken });
    if (death.answer) tokenAnswer = death.answer;

    await scanCredentialRefreshes();
    await until(() => announced.length === 1);
    await settle();

    expect(exchanges).toBe(death.exchanged);
    expect((await readRow(id)).needsReconnection).toBe(true);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ credentialId: id, cause: death.cause });
    await db
      .update(modelProviderCredentials)
      .set({ refreshCheckedAt: null })
      .where(eq(modelProviderCredentials.id, id));
    expect(await claimedModels()).toBe(0);
  });
});
