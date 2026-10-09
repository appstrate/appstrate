// SPDX-License-Identifier: Apache-2.0

/**
 * `refreshConnectionCredential` — the one decision over a connection's credential — and the
 * refresh it runs: the write-back (outputs kept, `scopes_granted` overwritten only by an echoed
 * `scope`, OAuth 2 §5.1), the freshness short-circuit on both sides of the lead window, the
 * pinning to the upstream the caller read, and the refresh-failure escalation.
 *
 * A controllable Bun.serve stands in for the token endpoint, which the manifest declares; each
 * connection pins a per-space OAuth client so the refresh context builds.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  decryptCredentialsToStringMap,
  encryptCredentialEnvelope,
  encryptCredentials,
} from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import {
  refreshConnectionCredential,
  type RefreshTarget,
  type RefreshTrigger,
} from "../../../src/services/integration-token-refresh.ts";
import {
  readCredentialRevision,
  recordIntegrationRefreshFailure,
} from "../../../src/services/integration-connections.ts";

const PACKAGE_ID = "@official/gmail";

/** An upstream 401 on the credential the connection holds. */
const REJECTED: RefreshTrigger = { kind: "rejected", revision: null };
const EXPIRING: RefreshTrigger = { kind: "expiring" };

interface TokenServer {
  url: string;
  setResponse: (body: Record<string, unknown>, status?: number) => void;
  /** Hold each request open, so overlapping exchanges are observable. */
  setDelayMs: (ms: number) => void;
  /** Highest number of exchanges this server ever served at the same time. */
  maxConcurrent: () => number;
  /** Forget that peak, so an assertion measures only what follows. */
  resetPeak: () => void;
  /** Run before each response, while the exchange is in flight. */
  setDuringExchange: (fn: (() => Promise<void>) | null) => void;
  /** Exchanges served so far. */
  requests: () => number;
  stop: () => void;
}

function startTokenServer(): TokenServer {
  let nextBody: Record<string, unknown> = {};
  let nextStatus = 200;
  let delayMs = 0;
  let inFlight = 0;
  let peak = 0;
  let served = 0;
  let duringExchange: (() => Promise<void>) | null = null;
  const server = (
    globalThis as unknown as {
      Bun: {
        serve: (opts: {
          port: number;
          hostname: string;
          fetch: (req: Request) => Promise<Response> | Response;
        }) => { port: number; hostname: string; stop: () => void };
      };
    }
  ).Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (duringExchange) await duringExchange();
      inFlight -= 1;
      served += 1;
      return new Response(JSON.stringify(nextBody), {
        status: nextStatus,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}/token`,
    setResponse: (body, status = 200) => {
      nextBody = body;
      nextStatus = status;
    },
    setDelayMs: (ms) => {
      delayMs = ms;
    },
    maxConcurrent: () => peak,
    resetPeak: () => {
      peak = 0;
    },
    setDuringExchange: (fn) => {
      duringExchange = fn;
    },
    requests: () => served,
    stop: () => server.stop(),
  };
}

function gmailManifest(tokenUrl: string): IntegrationManifest {
  return {
    schema_version: "0.1",
    type: "integration",
    name: PACKAGE_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.0.0" } },
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

/**
 * The integration, its token endpoint at `token`, and the per-space OAuth client a connection
 * pins (`client_ref`) so its refresh context builds. Returns that client's id.
 */
async function seedPinnedClient(ctx: TestContext, token: TokenServer): Promise<string> {
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
  return client!.id;
}

type Target = RefreshTarget & {
  expiresAt: Date | null;
  credentialRevision: string;
  variables: Record<string, string> | null;
};

/** The connection as a resolver reads it: what a refresh is pinned to. */
async function readTarget(connId: string): Promise<Target> {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      clientRef: integrationConnections.clientRef,
      oauthResource: integrationConnections.oauthResource,
      expiresAt: integrationConnections.expiresAt,
      variables: integrationConnections.variables,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return { ...row!, credentialRevision: (await readCredentialRevision(connId))! };
}

/** Ask `refreshConnectionCredential` about `target` for the test context's owner. */
function refreshOf(
  ctx: TestContext,
  token: TokenServer,
  target: Target,
  trigger: RefreshTrigger = REJECTED,
) {
  const manifest = gmailManifest(token.url);
  return refreshConnectionCredential({
    connection: { ...target, authKey: "primary" },
    integrationId: PACKAGE_ID,
    manifest,
    authDef: manifest.auths!.primary as AfpsManifestAuth,
    scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
    actor: { type: "user", id: ctx.user.id },
    trigger,
  });
}

/** The fields of a `refreshed` outcome. */
function refreshedFields(
  outcome: Awaited<ReturnType<typeof refreshConnectionCredential>>,
): Record<string, string> {
  if (outcome.status !== "refreshed") {
    throw new Error(`expected a refreshed outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome.fields;
}

async function fetchEncrypted(connId: string): Promise<string | null> {
  const [row] = await db
    .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return row?.credentialsEncrypted ?? null;
}

async function storedScopes(connId: string): Promise<string[]> {
  const [row] = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return [...row!.scopesGranted].sort();
}

describe("refreshConnectionCredential — the refresh and its write-back", () => {
  let ctx: TestContext;
  let token: TokenServer;
  let clientId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh" });
    token = startTokenServer();
    clientId = await seedPinnedClient(ctx, token);
  });

  afterEach(() => {
    token.stop();
  });

  async function seedConnection(initialScopes: string[], expiresAt?: Date): Promise<string> {
    const ciphertext = encryptCredentialEnvelope({
      outputs: {
        access_token: "old-access",
        accessToken: "old-access",
        refresh_token: "rt-1",
        refreshToken: "rt-1",
      },
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: PACKAGE_ID,
        authKey: "primary",
        accountId: "acct-1",
        label: "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: ciphertext,
        scopesGranted: initialScopes,
        clientRef: clientId,
        ...(expiresAt ? { expiresAt } : {}),
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  const refresh = async (connId: string, trigger: RefreshTrigger = REJECTED) =>
    refreshOf(ctx, token, await readTarget(connId), trigger);

  it("preserves scopesGranted when the refresh response omits `scope`", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600 });

    expect(refreshedFields(await refresh(connId)).access_token).toBe("new-access");
    // Untouched — `scope` was absent on the wire so the high-water-mark stays.
    expect(await storedScopes(connId)).toEqual(["read", "send"]);
  });

  it("keeps the outputs a refresh response does not send again, and takes those it does", async () => {
    const connId = await seedConnection(["read", "send"]);
    await db
      .update(integrationConnections)
      .set({
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: {
            access_token: "old-access",
            refresh_token: "rt-1",
            token_type: "Bearer",
            id_token: "idt-1",
            scope: "read send",
          },
        }),
      })
      .where(eq(integrationConnections.id, connId));

    token.setResponse({ access_token: "access-2", expires_in: 3600 });
    const kept = {
      access_token: "access-2",
      refresh_token: "rt-1",
      token_type: "Bearer",
      id_token: "idt-1",
      scope: "read send",
    };
    expect(refreshedFields(await refresh(connId))).toEqual(kept);
    expect(decryptCredentialsToStringMap((await fetchEncrypted(connId))!)).toEqual(kept);

    token.setResponse({
      access_token: "access-3",
      refresh_token: "rt-2",
      token_type: "DPoP",
      id_token: "idt-2",
      scope: "read",
      expires_in: 3600,
    });
    expect(refreshedFields(await refresh(connId))).toEqual({
      access_token: "access-3",
      refresh_token: "rt-2",
      token_type: "DPoP",
      id_token: "idt-2",
      scope: "read",
    });
  });

  it("writes back scopesGranted unchanged when the IdP echoes the same set", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read send" });

    refreshedFields(await refresh(connId));
    expect(await storedScopes(connId)).toEqual(["read", "send"]);
  });

  it("persists a narrowed grant, and leaves the connection usable when no agent needs the lost scope", async () => {
    const connId = await seedConnection(["read", "send", "delete"]);
    // User went to their Google account and revoked `delete`.
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read send" });

    refreshedFields(await refresh(connId));
    expect(await storedScopes(connId)).toEqual(["read", "send"]);
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(false);
  });

  it("persists a widened grant (scope creep): the high-water-mark moves up", async () => {
    const connId = await seedConnection(["read"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read send" });

    refreshedFields(await refresh(connId));
    expect(await storedScopes(connId)).toEqual(["read", "send"]);
  });

  it("an echoed `scope` holding no token keeps the stored grant and flags nothing", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: " " });

    expect(refreshedFields(await refresh(connId)).access_token).toBe("new-access");
    expect(await storedScopes(connId)).toEqual(["read", "send"]);
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(false);
  });

  // ── The lead window and the freshness short-circuit, both sides of them ──
  //
  // A rejection is evidence against the stored token whatever its remaining lifetime; an
  // `expiring` trigger is not, so it neither exchanges ahead of the lead window nor spends a
  // refresh_token a peer has just rotated.

  it("a rejection refreshes a token that is nowhere near expiry", async () => {
    const connId = await seedConnection(["read"], new Date(Date.now() + 50 * 60_000));
    token.setResponse({ access_token: "rotated", expires_in: 3600 });

    expect(refreshedFields(await refresh(connId)).access_token).toBe("rotated");
  });

  it("an expiring trigger keeps a token that is nowhere near expiry, without an exchange", async () => {
    const connId = await seedConnection(["read"], new Date(Date.now() + 50 * 60_000));
    token.setResponse({ access_token: "must-not-be-fetched", expires_in: 3600 });

    expect(await refresh(connId, EXPIRING)).toMatchObject({ status: "kept" });
    expect(token.requests()).toBe(0);
  });

  it("a rejection of a credential the connection no longer holds is a read", async () => {
    const connId = await seedConnection(["read"], new Date(Date.now() + 50 * 60_000));
    const held = (await readTarget(connId)).credentialRevision;
    await db
      .update(integrationConnections)
      .set({
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { access_token: "peer-access", refresh_token: "rt-2" },
        }),
      })
      .where(eq(integrationConnections.id, connId));
    token.setResponse({ access_token: "must-not-be-fetched", expires_in: 3600 });

    expect(await refresh(connId, { kind: "rejected", revision: held })).toMatchObject({
      status: "kept",
    });
    expect(token.requests()).toBe(0);
  });

  it("never exchanges concurrently for a rejection and an expiring trigger on one connection", async () => {
    // Expiry INSIDE the 5-minute lead window, so the expiring trigger has no short-circuit either
    // when it starts: both want the endpoint, and only the per-key serialization in
    // `dedupedRefresh` keeps them apart.
    const connId = await seedConnection(["read"], new Date(Date.now() + 2 * 60_000));
    token.setResponse({ access_token: "rotated", expires_in: 3600 });
    token.setDelayMs(50);
    // The assertion below must measure these two flights and nothing else.
    token.resetPeak();

    const target = await readTarget(connId);
    const [forced, proactive] = await Promise.all([
      refreshOf(ctx, token, target, REJECTED),
      refreshOf(ctx, token, target, EXPIRING),
    ]);

    expect(refreshedFields(forced).access_token).toBe("rotated");
    // The proactive flight answers from the row the forced one wrote (or adopts its exchange)
    // instead of spending the refresh_token a second time.
    expect(refreshedFields(proactive).access_token).toBe("rotated");
    expect(token.maxConcurrent()).toBe(1);
    expect(token.requests()).toBe(1);
  });

  // A reconnect through another client (another authorization server) while a refresh waited:
  // the refresh must neither spend the new credential at the old server nor hand back its token.
  it("answers retry once the connection was reconnected elsewhere, without an exchange", async () => {
    const connId = await seedConnection(["read"]);
    const target = await readTarget(connId);
    const reconnected = encryptCredentialEnvelope({
      outputs: { access_token: "other-access", refresh_token: "other-rt" },
    });
    await db
      .update(integrationConnections)
      .set({ credentialsEncrypted: reconnected, clientRef: "other-client" })
      .where(eq(integrationConnections.id, connId));
    token.setResponse({ access_token: "must-not-be-fetched", expires_in: 3600 });

    expect(await refreshOf(ctx, token, target)).toMatchObject({
      status: "retry",
      cause: "connection_changed",
    });
    expect(token.requests()).toBe(0);
    expect(await fetchEncrypted(connId)).toBe(reconnected);
  });

  it("discards a token refreshed while the connection was reconnected, and answers retry", async () => {
    const connId = await seedConnection(["read"]);
    const reconnected = encryptCredentialEnvelope({
      outputs: { access_token: "other-access", refresh_token: "other-rt" },
    });
    token.setResponse({ access_token: "stale-server-access", expires_in: 3600 });
    token.setDuringExchange(async () => {
      await db
        .update(integrationConnections)
        .set({ credentialsEncrypted: reconnected, clientRef: "other-client" })
        .where(eq(integrationConnections.id, connId));
    });

    expect(await refresh(connId)).toMatchObject({ status: "retry", cause: "connection_changed" });
    expect(token.requests()).toBe(1);
    expect(await fetchEncrypted(connId)).toBe(reconnected);
  });

  it("throws the 503 for a stored blob under a missing kid (not transient)", async () => {
    const connId = await seedConnection(["read"]);
    await db
      .update(integrationConnections)
      .set({ credentialsEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}` })
      .where(eq(integrationConnections.id, connId));

    await expect(refresh(connId)).rejects.toMatchObject({
      status: 503,
      code: "encryption_key_unavailable",
    });
    expect(token.requests()).toBe(0);
  });

  it("rethrows a fault that is no verdict on the connection, never answering retry", async () => {
    const connId = await seedConnection(["read"]);
    await db
      .update(integrationConnections)
      .set({ credentialsEncrypted: "not-a-ciphertext" })
      .where(eq(integrationConnections.id, connId));

    await expect(refresh(connId)).rejects.toMatchObject({ name: "CredentialDecryptError" });
    expect(token.requests()).toBe(0);
  });
});

/**
 * Transient-refresh-failure escalation.
 *
 * `recordIntegrationRefreshFailure` increments a per-connection counter on every transient
 * (non-`invalid_grant`) refresh failure and flips `needsReconnection` ONLY when the streak
 * crosses the threshold AND the token is already expired past the grace window. A successful
 * credential write resets the counter (via `persistCredentialBundle`).
 */
describe("integration refresh-failure escalation", () => {
  let ctx: TestContext;
  let token: TokenServer;
  let clientId: string;
  const HOUR_MS = 3_600_000;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh-esc" });
    token = startTokenServer();
    clientId = await seedPinnedClient(ctx, token);
  });

  afterEach(() => {
    token.stop();
  });

  async function seedConn(opts: {
    expiresAt: Date | null;
    refreshFailureCount?: number;
    needsReconnection?: boolean;
  }): Promise<string> {
    const ciphertext = encryptCredentialEnvelope({
      outputs: {
        access_token: "old-access",
        accessToken: "old-access",
        refresh_token: "rt-1",
        refreshToken: "rt-1",
      },
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: PACKAGE_ID,
        authKey: "primary",
        accountId: "acct-1",
        label: "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: ciphertext,
        expiresAt: opts.expiresAt,
        refreshFailureCount: opts.refreshFailureCount ?? 0,
        needsReconnection: opts.needsReconnection ?? false,
        clientRef: clientId,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function readRow(connId: string) {
    return db
      .select({
        refreshFailureCount: integrationConnections.refreshFailureCount,
        needsReconnection: integrationConnections.needsReconnection,
        credentialsEncrypted: integrationConnections.credentialsEncrypted,
        expiresAt: integrationConnections.expiresAt,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId))
      .then((r) => r[0]!);
  }

  it("increments the counter but does NOT escalate while the token is still valid", async () => {
    // Token valid for another hour — a transient upstream blip must not brick it.
    const connId = await seedConn({ expiresAt: new Date(Date.now() + HOUR_MS) });

    // Drive the streak to (and past) the threshold.
    for (let i = 0; i < 4; i++)
      await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });

    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(4);
    expect(row.needsReconnection).toBe(false); // expiry gate blocks escalation
  });

  it("does NOT escalate while the token is expired but within the grace window", async () => {
    // Expired 10 min ago; grace is 1h → not yet escalatable.
    const connId = await seedConn({ expiresAt: new Date(Date.now() - 10 * 60_000) });

    for (let i = 0; i < 5; i++)
      await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });

    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(5);
    expect(row.needsReconnection).toBe(false);
  });

  it("escalates to needsReconnection once expired past grace AND streak hits threshold", async () => {
    // Expired 2h ago, grace 1h → past grace.
    const connId = await seedConn({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) });

    await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 }); // 1 — below threshold
    expect((await readRow(connId)).needsReconnection).toBe(false);
    await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 }); // 2 — below threshold
    expect((await readRow(connId)).needsReconnection).toBe(false);
    await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 }); // 3 — hits threshold

    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(3);
    expect(row.needsReconnection).toBe(true);
  });

  it("never clears a pre-existing needsReconnection (OR semantics)", async () => {
    const connId = await seedConn({
      expiresAt: new Date(Date.now() + HOUR_MS), // valid token — gate would say false
      needsReconnection: true, // but already flagged (e.g. revoke)
    });

    await recordIntegrationRefreshFailure(connId, 3, { graceSeconds: 3600 });

    expect((await readRow(connId)).needsReconnection).toBe(true);
  });

  const refresh = async (connId: string, trigger: RefreshTrigger = REJECTED) =>
    refreshOf(ctx, token, await readTarget(connId), trigger);

  it("a successful refresh resets the failure streak", async () => {
    // Seed an expired token with an accumulated streak (not yet escalated).
    const connId = await seedConn({
      expiresAt: new Date(Date.now() - 30 * 60_000),
      refreshFailureCount: 2,
    });
    token.setResponse({ access_token: "fresh-access", expires_in: 3600 });

    refreshedFields(await refresh(connId));

    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(0);
    expect(row.needsReconnection).toBe(false);
  });

  // A 2xx body with no `access_token` is a failed refresh, never a success with
  // the current token spliced in — that would re-persist the dead token, reset
  // `needsReconnection` and the streak, and (with no `expires_in`) drop the
  // row's `expires_at`, after which neither the lead window nor this escalation
  // could fire again. With no `error` either, it is transient: counted.
  it("treats a 2xx without access_token as a failure and increments the counter", async () => {
    const connId = await seedConn({
      expiresAt: new Date(Date.now() - HOUR_MS),
      refreshFailureCount: 1,
    });
    token.setResponse({}, 200);

    expect(await refresh(connId)).toMatchObject({
      status: "retry",
      cause: "upstream_transient",
      detail: expect.stringMatching(/HTTP 200 without access_token/),
    });

    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(2);
    expect(row.needsReconnection).toBe(false);
  });

  // Some IdPs answer a failed grant with a 2xx RFC 6749 §5.2 error object: the
  // same verdict as a 400 `invalid_grant` — revoked, flagged, not counted.
  it("treats a 2xx `invalid_grant` error object as revoked and flags the connection", async () => {
    const connId = await seedConn({
      expiresAt: new Date(Date.now() - HOUR_MS),
      refreshFailureCount: 1,
    });
    token.setResponse({ error: "invalid_grant" }, 200);

    expect(await refresh(connId)).toMatchObject({ status: "dead", cause: "refresh_token_revoked" });

    const row = await readRow(connId);
    expect(row.needsReconnection).toBe(true);
    expect(row.refreshFailureCount).toBe(1);
  });

  it("a transient upstream failure during refresh increments the counter and answers retry", async () => {
    const connId = await seedConn({ expiresAt: new Date(Date.now() - HOUR_MS) });
    token.setResponse({ error: "temporarily_unavailable" }, 503); // 5xx → transient

    expect(await refresh(connId)).toMatchObject({ status: "retry", cause: "upstream_transient" });
    expect((await readRow(connId)).refreshFailureCount).toBe(1);
  });

  // A reconnect cannot repair a client the token endpoint refuses: never counted, never flagged,
  // even on a token expired past the grace window with a streak one short of the threshold.
  it.each(["invalid_client", "unauthorized_client"])(
    "a refused client (%s) answers retry without counting toward the streak",
    async (error) => {
      const { INTEGRATION_REFRESH_MAX_FAILURES: max, INTEGRATION_REFRESH_GRACE_SECONDS: grace } =
        getEnv();
      const connId = await seedConn({
        expiresAt: new Date(Date.now() - (grace + 3600) * 1000),
        refreshFailureCount: max - 1,
      });
      token.setResponse({ error }, 401);

      expect(await refresh(connId)).toMatchObject({
        status: "retry",
        cause: "oauth_client_rejected",
      });
      const row = await readRow(connId);
      expect(row.refreshFailureCount).toBe(max - 1);
      expect(row.needsReconnection).toBe(false);
    },
  );

  it("the transient failure that escalates the streak answers dead", async () => {
    const { INTEGRATION_REFRESH_MAX_FAILURES: max, INTEGRATION_REFRESH_GRACE_SECONDS: grace } =
      getEnv();
    const connId = await seedConn({
      expiresAt: new Date(Date.now() - (grace + 3600) * 1000),
      refreshFailureCount: max - 1,
    });
    token.setResponse({ error: "temporarily_unavailable" }, 503);

    expect(await refresh(connId)).toMatchObject({
      status: "dead",
      cause: "refresh_failures_exhausted",
      detail: expect.stringContaining("HTTP 503"),
    });
    const row = await readRow(connId);
    expect(row.refreshFailureCount).toBe(max);
    expect(row.needsReconnection).toBe(true);
  });

  // ── A connection flagged needsReconnection never spends its refresh token ──
  //
  // A write that clears the flag only matches an unflagged row (`persistCredentialBundle`,
  // "Monotonic clear"), so an exchange on a flagged row could only burn the refresh token a
  // rotating IdP just replaced. The flag is read under the refresh lock: a rejection then finds
  // the credential dead, an expiring trigger keeps serving the stored token.
  describe("on a connection already flagged needsReconnection", () => {
    let connId: string;
    let seeded: Awaited<ReturnType<typeof readRow>>;

    beforeEach(async () => {
      // Expired, so the freshness re-read could not answer even an expiring trigger.
      connId = await seedConn({
        expiresAt: new Date(Date.now() - HOUR_MS),
        needsReconnection: true,
      });
      seeded = await readRow(connId);
      token.setResponse({ access_token: "fresh-access", expires_in: 3600 });
    });

    async function expectUntouched(): Promise<void> {
      expect(token.requests()).toBe(0);
      const row = await readRow(connId);
      expect(row.needsReconnection).toBe(true);
      expect(row.refreshFailureCount).toBe(seeded.refreshFailureCount);
      expect(row.credentialsEncrypted).toBe(seeded.credentialsEncrypted);
      expect(row.expiresAt).toEqual(seeded.expiresAt);
    }

    it("a rejection answers dead without an exchange", async () => {
      expect(await refresh(connId)).toMatchObject({ status: "dead", cause: "connection_flagged" });
      await expectUntouched();
    });

    it("an expiring trigger keeps the stored credential without an exchange", async () => {
      expect(await refresh(connId, EXPIRING)).toMatchObject({
        status: "kept",
        cause: "connection_flagged",
      });
      await expectUntouched();
    });
  });

  it("a connection flagged while its token was refreshed answers dead, keeping the flag", async () => {
    const connId = await seedConn({ expiresAt: new Date(Date.now() - HOUR_MS) });
    const seeded = await readRow(connId);
    token.setResponse({ access_token: "fresh-access", expires_in: 3600 });
    token.setDuringExchange(async () => {
      await db
        .update(integrationConnections)
        .set({ needsReconnection: true })
        .where(eq(integrationConnections.id, connId));
    });

    expect(await refresh(connId)).toMatchObject({ status: "dead", cause: "connection_flagged" });
    expect(token.requests()).toBe(1);
    const row = await readRow(connId);
    expect(row.needsReconnection).toBe(true);
    expect(row.credentialsEncrypted).toBe(seeded.credentialsEncrypted);
  });
});
