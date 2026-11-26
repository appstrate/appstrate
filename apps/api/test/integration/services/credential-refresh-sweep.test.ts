// SPDX-License-Identifier: Apache-2.0

/**
 * The background credential refresh sweep: which rows a scan claims, that a claim spends the day's
 * visit, and what the per-row job does with a claimed row of each kind.
 *
 * A row is due when its token expires within the refresh lead (or has) AND no visit stamped
 * `refresh_checked_at` within the visit interval (23 h). The jobs are driven directly (`handleCredentialRefreshJob`)
 * rather than through a queue; the token endpoint is the canned OAuth server (integrations) or a
 * `fetch` swap (model providers).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
  decryptCredentials,
  decryptCredentialsToStringMap,
  encryptCredentialEnvelope,
  encryptCredentials,
} from "@appstrate/connect";
import {
  integrationConnections,
  integrationOauthClients,
  modelProviderCredentials,
} from "@appstrate/db/schema";
import type { Logger } from "@appstrate/core/logger";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedOrgModelProviderOAuth,
  seedPackage,
  seedPublishedVersion,
} from "../../helpers/seed.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import { announced, installDeathSpy, settle, until } from "../../helpers/credential-death-spy.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { createMockOAuthServer } from "../../helpers/oauth-server.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import {
  handleCredentialRefreshJob,
  scanCredentialRefreshes,
  shutdownCredentialRefreshSweep,
  type CredentialRefreshKind,
} from "../../../src/services/credential-refresh-sweep.ts";

const HOUR = 60 * 60_000;
const INTEGRATION_ID = "@sweeporg/gmail";

const originalFetch = globalThis.fetch;
const mockServer = createMockOAuthServer();

afterAll(async () => {
  mockServer.stop();
  await shutdownCredentialRefreshSweep();
  restoreDiscoveredModules();
});

interface LogLine {
  level: keyof Logger;
  msg: string;
  data: Record<string, unknown>;
}

function captureLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: keyof Logger) =>
    (msg: string, data?: Record<string, unknown>): void => {
      lines.push({ level, msg, data: data ?? {} });
    };
  return {
    log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

async function runJob(kind: CredentialRefreshKind, id: string): Promise<LogLine[]> {
  const { log, lines } = captureLog();
  await handleCredentialRefreshJob({ data: { kind, id } }, log);
  return lines;
}

/** Ids stamped by a scan: the scan's claim, read back from `refresh_checked_at`. */
async function claimedBy(scan: () => Promise<unknown>): Promise<{
  integrations: string[];
  models: string[];
}> {
  const since = new Date(Date.now() - 1);
  await scan();
  const conns = await db
    .select({ id: integrationConnections.id, at: integrationConnections.refreshCheckedAt })
    .from(integrationConnections);
  const models = await db
    .select({ id: modelProviderCredentials.id, at: modelProviderCredentials.refreshCheckedAt })
    .from(modelProviderCredentials);
  const fresh = (r: { at: Date | null }) => r.at !== null && r.at >= since;
  return {
    integrations: conns.filter(fresh).map((r) => r.id),
    models: models.filter(fresh).map((r) => r.id),
  };
}

// ─── integration connections ────────────────────────────────

describe("credential refresh sweep — integration connections", () => {
  let ctx: TestContext;
  let clientId: string;

  async function seedIntegration(): Promise<void> {
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION_ID,
        displayName: "Gmail",
        description: "Gmail integration",
        auths: {
          google: {
            type: "oauth2",
            authorizationEndpoint: `${mockServer.url}/authorize`,
            tokenEndpoint: `${mockServer.url}/token`,
            defaultScopes: ["openid"],
            authorizedUris: ["https://gmail.googleapis.com/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "access_token",
            }),
          },
        },
      }),
    });
    const [client] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        integrationId: INTEGRATION_ID,
        authKey: "google",
        clientId: "client_abc",
        clientSecretEncrypted: encryptCredentials({ client_secret: "secret_xyz" }),
      })
      .returning({ id: integrationOauthClients.id });
    clientId = client!.id;
  }

  let seq = 0;
  async function seedConnection(opts: {
    /** Relative to now; `null` = no expiry. */
    expiresInMs: number | null;
    /** How long ago the sweep or a write last visited it; `null` = never. */
    visitedAgoMs?: number | null;
    needsReconnection?: boolean;
    /** `false`: a non-OAuth2 row. */
    oauth?: boolean;
  }): Promise<string> {
    seq += 1;
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "google",
        accountId: `acct-${seq}`,
        label: `acct-${seq}`,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { access_token: "stale_token", refresh_token: "rt_old" },
        }),
        scopesGranted: ["openid"],
        clientRef: opts.oauth === false ? null : clientId,
        expiresAt: opts.expiresInMs === null ? null : new Date(Date.now() + opts.expiresInMs),
        refreshCheckedAt:
          opts.visitedAgoMs == null ? null : new Date(Date.now() - opts.visitedAgoMs),
        needsReconnection: opts.needsReconnection ?? false,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function readRow(id: string) {
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return row!;
  }

  const tokenRequests = () =>
    mockServer.requests.filter((r) => r.method === "POST" && r.path === "/token");

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
    await seedIntegration();
  });

  const publish = () => seedPublishedVersion(INTEGRATION_ID, "1.0.0");

  describe("due predicate", () => {
    it("claims an expired row that was never visited", async () => {
      const id = await seedConnection({ expiresInMs: -HOUR });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([id]);
    });

    it("claims a row expiring within the lead that was visited more than a day ago", async () => {
      const id = await seedConnection({ expiresInMs: 60_000, visitedAgoMs: 25 * HOUR });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([id]);
    });

    it("skips a row visited within the day", async () => {
      await seedConnection({ expiresInMs: -HOUR, visitedAgoMs: HOUR });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([]);
    });

    it("skips a row whose token is valid beyond the lead", async () => {
      await seedConnection({ expiresInMs: 10 * 60_000 });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([]);
    });

    it("skips a row with no expiry", async () => {
      await seedConnection({ expiresInMs: null });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([]);
    });

    it("skips a flagged row and a non-OAuth2 row", async () => {
      await seedConnection({ expiresInMs: -HOUR, needsReconnection: true });
      await seedConnection({ expiresInMs: -HOUR, oauth: false });
      expect((await claimedBy(scanCredentialRefreshes)).integrations).toEqual([]);
    });
  });

  describe("claim", () => {
    it("stamps the visit, so a second scan right after claims nothing", async () => {
      const id = await seedConnection({ expiresInMs: -HOUR });

      const first = await scanCredentialRefreshes();
      expect(first.integration_connection.claimed).toBe(1);
      expect((await readRow(id)).refreshCheckedAt).not.toBeNull();

      const second = await scanCredentialRefreshes();
      expect(second.integration_connection.claimed).toBe(0);
    });

    it("never hands the same row to two concurrent scans", async () => {
      for (let i = 0; i < 5; i++) await seedConnection({ expiresInMs: -HOUR });

      const [a, b] = await Promise.all([scanCredentialRefreshes(), scanCredentialRefreshes()]);

      expect(a.integration_connection.claimed + b.integration_connection.claimed).toBe(5);
    });
  });

  describe("job", () => {
    it("performs one exchange, persists the rotated refresh token and moves expires_at", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });
      const before = (await readRow(id)).expiresAt!.getTime();

      const lines = await runJob("integration_connection", id);

      expect(tokenRequests()).toHaveLength(1);
      expect(new URLSearchParams(tokenRequests()[0]!.body).get("refresh_token")).toBe("rt_old");
      const row = await readRow(id);
      const fields = decryptCredentialsToStringMap(row.credentialsEncrypted);
      expect(fields.access_token).toBe("fresh_token");
      expect(fields.refresh_token).toBe("rt_rotated");
      expect(row.expiresAt!.getTime()).toBeGreaterThan(before);
      expect(lines.map((l) => [l.level, l.msg])).toEqual([
        ["info", "credential_refresh_integration_refreshed"],
      ]);
    });

    it("counts a transient failure and does not claim the row again on the next scan", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });
      mockServer.setTokenStatus(503);
      mockServer.setTokenResponse({ error: "temporarily_unavailable" });

      expect((await scanCredentialRefreshes()).integration_connection.claimed).toBe(1);
      const lines = await runJob("integration_connection", id);

      expect((await readRow(id)).refreshFailureCount).toBe(1);
      expect(lines.map((l) => l.level)).toEqual(["warn"]);
      expect((await scanCredentialRefreshes()).integration_connection.claimed).toBe(0);
    });

    it("flags the row on invalid_grant and takes it out of the due set", async () => {
      await publish();
      const id = await seedConnection({ expiresInMs: -HOUR });
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({ error: "invalid_grant" });

      const lines = await runJob("integration_connection", id);

      expect((await readRow(id)).needsReconnection).toBe(true);
      expect(lines.map((l) => l.level)).toEqual(["warn"]);
      // Even a visit older than a day does not bring a flagged row back.
      await db
        .update(integrationConnections)
        .set({ refreshCheckedAt: null })
        .where(eq(integrationConnections.id, id));
      expect((await scanCredentialRefreshes()).integration_connection.claimed).toBe(0);
    });

    it("skips an integration with no published version and leaves the row untouched", async () => {
      const id = await seedConnection({ expiresInMs: -HOUR });
      const before = await readRow(id);

      const lines = await runJob("integration_connection", id);

      expect(tokenRequests()).toHaveLength(0);
      expect(lines).toEqual([
        {
          level: "info",
          msg: "credential_refresh_integration_skipped",
          data: expect.objectContaining({ connectionId: id, reason: "not_published" }),
        },
      ]);
      const after = await readRow(id);
      expect(after.credentialsEncrypted).toBe(before.credentialsEncrypted);
      expect(after.refreshFailureCount).toBe(0);
      expect(after.needsReconnection).toBe(false);
    });

    it("ignores a row that is gone", async () => {
      expect(
        await runJob("integration_connection", "00000000-0000-0000-0000-000000000000"),
      ).toEqual([]);
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

  async function claimedModels(): Promise<string[]> {
    return (await claimedBy(scanCredentialRefreshes)).models;
  }

  it("claims an expired never-visited credential and one expiring within the lead", async () => {
    const expired = await seedOAuth({ expiresInMs: -HOUR });
    const expiring = await seedOAuth({ expiresInMs: 60_000, visitedAgoMs: 25 * HOUR });
    expect((await claimedModels()).sort()).toEqual([expired, expiring].sort());
  });

  it("skips a credential visited within the day, valid beyond the lead, flagged, or with no expiry", async () => {
    await seedOAuth({ expiresInMs: -HOUR, visitedAgoMs: HOUR });
    await seedOAuth({ expiresInMs: 10 * 60_000 });
    await seedOAuth({ expiresInMs: null });
    await seedOAuth({ expiresInMs: -HOUR, flagged: true });
    expect(await claimedModels()).toEqual([]);
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
    expect(await claimedModels()).toEqual([]);
  });

  it("stamps the visit, so a second scan claims nothing", async () => {
    await seedOAuth({ expiresInMs: -HOUR });
    expect((await scanCredentialRefreshes()).model_provider_credential.claimed).toBe(1);
    expect((await scanCredentialRefreshes()).model_provider_credential.claimed).toBe(0);
  });

  it("refreshes an expired credential: new tokens, new expiry, a fresh visit stamp, a cleared streak", async () => {
    const id = await seedOAuth({ expiresInMs: -HOUR });
    await db
      .update(modelProviderCredentials)
      .set({ refreshFailureCount: 2 })
      .where(eq(modelProviderCredentials.id, id));
    const startedAt = Date.now();

    const lines = await runJob("model_provider_credential", id);

    expect(exchanges).toBe(1);
    expect(lines.map((l) => [l.level, l.msg])).toEqual([["info", "credential_refresh_model_ok"]]);
    const row = await readRow(id);
    expect(row.expiresAt!.getTime()).toBeGreaterThan(startedAt + 3000_000);
    expect(row.refreshCheckedAt!.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(row.refreshFailureCount).toBe(0);
    expect(decryptCredentials<{ accessToken: string }>(row.credentialsEncrypted)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "rt-new",
    });
  });

  it("counts a failed exchange, does not throw, and leaves the credential usable", async () => {
    const id = await seedOAuth({ expiresInMs: -HOUR });
    tokenAnswer = { status: 503, body: { error: "temporarily_unavailable" } };

    const lines = await runJob("model_provider_credential", id);

    expect(lines.map((l) => [l.level, l.msg])).toEqual([["error", "credential_refresh_failed"]]);
    const row = await readRow(id);
    expect(row.refreshFailureCount).toBe(1);
    expect(row.needsReconnection).toBe(false);
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

    const lines = await runJob("model_provider_credential", id);
    await until(() => announced.length === 1);
    await settle();

    expect(exchanges).toBe(death.exchanged);
    expect(lines).toEqual([
      {
        level: "warn",
        msg: "credential_refresh_model_needs_reconnection",
        data: expect.objectContaining({ credentialId: id, cause: death.cause }),
      },
    ]);
    expect((await readRow(id)).needsReconnection).toBe(true);
    expect(announced).toEqual([
      {
        kind: "model_provider_credential",
        orgId: ctx.orgId,
        credentialId: id,
        providerId: "test-oauth",
        cause: death.cause,
      },
    ]);
    await db
      .update(modelProviderCredentials)
      .set({ refreshCheckedAt: null })
      .where(eq(modelProviderCredentials.id, id));
    expect(await claimedModels()).toEqual([]);
  });

  it("skips, without exchanging or announcing, a credential flagged since the claim", async () => {
    const id = await seedOAuth({ expiresInMs: -HOUR, flagged: true });

    const lines = await runJob("model_provider_credential", id);
    await settle();

    expect(exchanges).toBe(0);
    expect(announced).toEqual([]);
    expect(lines).toEqual([
      {
        level: "debug",
        msg: "credential_refresh_model_skipped_flagged",
        data: expect.objectContaining({ credentialId: id, cause: "connection_flagged" }),
      },
    ]);
  });

  it("warns, and throws nothing, for a credential deleted between the claim and the job", async () => {
    const lines = await runJob("model_provider_credential", crypto.randomUUID());
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ["warn", "credential_refresh_model_unavailable"],
    ]);
  });
});
