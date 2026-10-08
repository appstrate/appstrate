// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6 — refresh-time scope-shrink awareness.
 *
 * `forceRefreshIntegrationConnection` is the refresh helper behind
 * `refreshConnectionCredential`. Phase 6 added two behaviours:
 *
 *   1. When the IdP echoes a `scope` field in the refresh response,
 *      `scopes_granted` on the DB row is overwritten with the new
 *      authoritative set (OAuth 2 §5.1).
 *   2. The result surfaces `shrinkDetected = true` when the new set is
 *      strictly narrower than the previously-stored one, so
 *      `refreshConnectionCredential` can cross-check against installed
 *      agents' `requiredScopes` and flip `needsReconnection` if the actor
 *      dropped below the floor.
 *
 * The tests below stand up a controllable Bun.serve as the upstream
 * token endpoint and walk the helper through the four cases that
 * matter: (a) response omits `scope` (no-op), (b) response keeps the
 * same scopes, (c) response shrinks, (d) response widens (scope creep).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients, packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  RefreshError,
  decryptCredentialsToStringMap,
  encryptCredentialEnvelope,
  encryptCredentials,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import {
  forceRefreshIntegrationConnection,
  refreshConnectionCredential,
  type RefreshTarget,
} from "../../../src/services/integration-token-refresh.ts";
import { recordIntegrationRefreshFailure } from "../../../src/services/integration-connections.ts";

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

describe("forceRefreshIntegrationConnection — Phase 6 scope-shrink awareness", () => {
  let ctx: TestContext;
  let token: TokenServer;
  const PACKAGE_ID = "@official/gmail";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh" });
    await seedPackage({
      id: PACKAGE_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
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
            token_endpoint: "https://idp/token",
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
      },
    });
    token = startTokenServer();
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
        ...(expiresAt ? { expiresAt } : {}),
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("preserves scopesGranted when the refresh response omits `scope`", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600 });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      {
        tokenEndpoint: token.url,
        clientId: "cid",
        clientSecret: "csec",
      },
    );

    expect(result.scopesGranted).toBeNull();
    expect(result.shrinkDetected).toBe(false);

    const [row] = await db
      .select({ scopesGranted: integrationConnections.scopesGranted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    // Untouched — `scope` was absent on the wire so the high-water-mark stays.
    expect(row!.scopesGranted).toEqual(["read", "send"]);
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
    const refresh = async () =>
      (
        await forceRefreshIntegrationConnection(await readTarget(connId), PACKAGE_ID, "primary", {
          tokenEndpoint: token.url,
          clientId: "cid",
          clientSecret: "csec",
        })
      ).fields;

    token.setResponse({ access_token: "access-2", expires_in: 3600 });
    const kept = {
      access_token: "access-2",
      refresh_token: "rt-1",
      token_type: "Bearer",
      id_token: "idt-1",
      scope: "read send",
    };
    expect(await refresh()).toEqual(kept);
    expect(decryptCredentialsToStringMap((await fetchEncrypted(connId))!)).toEqual(kept);

    token.setResponse({
      access_token: "access-3",
      refresh_token: "rt-2",
      token_type: "DPoP",
      id_token: "idt-2",
      scope: "read",
      expires_in: 3600,
    });
    expect(await refresh()).toEqual({
      access_token: "access-3",
      refresh_token: "rt-2",
      token_type: "DPoP",
      id_token: "idt-2",
      scope: "read",
    });
  });

  it("writes back scopesGranted unchanged when the IdP echoes the same set", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({
      access_token: "new-access",
      expires_in: 3600,
      scope: "read send",
    });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );

    expect(result.scopesGranted?.sort()).toEqual(["read", "send"]);
    expect(result.shrinkDetected).toBe(false);
  });

  it("detects shrink when the IdP returns fewer scopes than previously granted", async () => {
    const connId = await seedConnection(["read", "send", "delete"]);
    // User went to their Google account and revoked `delete`.
    token.setResponse({
      access_token: "new-access",
      expires_in: 3600,
      scope: "read send",
    });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );

    expect(result.shrinkDetected).toBe(true);
    expect(result.scopesGranted?.sort()).toEqual(["read", "send"]);

    const [row] = await db
      .select({ scopesGranted: integrationConnections.scopesGranted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.scopesGranted.sort()).toEqual(["read", "send"]);
  });

  // ── The freshness short-circuit, both sides of it ──
  //
  // `dedupedRefresh` re-reads the row after winning the lock and may answer
  // from it instead of spending the refresh_token. That short-circuit is
  // correct for a PROACTIVE refresh and wrong for a FORCED one, so both
  // directions are pinned here: removing it entirely would burn a peer's
  // just-rotated token on every lead-window pass, and leaving it in the forced
  // path is the bug it was masking.

  it("force (default): refreshes a token that is nowhere near expiry", async () => {
    const connId = await seedConnection(["read"], new Date(Date.now() + 50 * 60_000));
    token.setResponse({ access_token: "rotated", expires_in: 3600 });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );

    expect(result.fields.access_token).toBe("rotated");
  });

  it("force:false: serves the stored token when it is nowhere near expiry", async () => {
    // CONTROL for the test above. The proactive caller has no evidence against
    // the stored token, and a peer may have written it microseconds ago — so
    // the exchange is skipped and the refresh_token is not double-spent. The
    // token server is armed with a DIFFERENT token, so contacting it would show.
    const connId = await seedConnection(["read"], new Date(Date.now() + 50 * 60_000));
    token.setResponse({ access_token: "must-not-be-fetched", expires_in: 3600 });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
      { force: false },
    );

    expect(result.fields.access_token).toBe("old-access");
  });

  it("never exchanges concurrently for a forced and a proactive refresh of one connection", async () => {
    // Expiry INSIDE the 5-minute lead window, so the proactive caller has no
    // short-circuit either when it starts: both flights want the endpoint, and
    // only the per-key serialization in `dedupedRefresh` keeps them apart.
    const connId = await seedConnection(["read"], new Date(Date.now() + 2 * 60_000));
    token.setResponse({ access_token: "rotated", expires_in: 3600 });
    token.setDelayMs(50);
    // The assertion below must measure these two flights and nothing else.
    token.resetPeak();

    const target = await readTarget(connId);
    const refreshCtx = { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" };
    const [forced, proactive] = await Promise.all([
      forceRefreshIntegrationConnection(target, PACKAGE_ID, "primary", refreshCtx),
      forceRefreshIntegrationConnection(target, PACKAGE_ID, "primary", refreshCtx, {
        force: false,
      }),
    ]);

    expect(forced.fields.access_token).toBe("rotated");
    // The proactive flight re-reads after the forced one wrote, so it answers
    // from the row instead of spending the refresh_token a second time.
    expect(proactive.fields.access_token).toBe("rotated");
    expect(token.maxConcurrent()).toBe(1);

    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(false);
  });

  // A reconnect through another client (another authorization server) while a refresh waited:
  // the refresh must neither spend the new credential at the old server nor hand back its token.
  it("refuses a refresh once the connection was reconnected elsewhere, without an exchange", async () => {
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

    const refused = forceRefreshIntegrationConnection(target, PACKAGE_ID, "primary", {
      tokenEndpoint: token.url,
      clientId: "cid",
      clientSecret: "csec",
    });
    await expect(refused).rejects.toBeInstanceOf(RefreshError);
    await expect(refused).rejects.toMatchObject({ kind: "transient" });
    expect(token.requests()).toBe(0);
    expect(await fetchEncrypted(connId)).toBe(reconnected);
  });

  it("discards a token refreshed while the connection was reconnected", async () => {
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

    const refused = forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );
    await expect(refused).rejects.toMatchObject({ name: "RefreshError", kind: "transient" });
    expect(token.requests()).toBe(1);
    expect(await fetchEncrypted(connId)).toBe(reconnected);
  });

  it("treats scope creep (response wider than stored) as non-shrink", async () => {
    const connId = await seedConnection(["read"]);
    token.setResponse({
      access_token: "new-access",
      expires_in: 3600,
      scope: "read send", // IdP added a scope the user previously had
    });

    const result = await forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );

    expect(result.shrinkDetected).toBe(false);
    expect(result.scopesGranted?.sort()).toEqual(["read", "send"]);

    const [row] = await db
      .select({ scopesGranted: integrationConnections.scopesGranted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    // The wider set is persisted — high-water-mark moves up.
    expect(row!.scopesGranted.sort()).toEqual(["read", "send"]);
  });

  it("refreshConnectionCredential throws the 503 for a stored blob under a missing kid (not transient)", async () => {
    const connId = await seedConnection(["read"]);
    // A resolvable pinned client: the refresh context builds, and the exchange is what decrypts.
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
    await db
      .update(integrationConnections)
      .set({
        credentialsEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}`,
        clientRef: client!.id,
      })
      .where(eq(integrationConnections.id, connId));
    const [pkg] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, PACKAGE_ID));
    const manifest = pkg!.draftManifest as unknown as IntegrationManifest;
    const outcome = refreshConnectionCredential({
      connection: { ...(await readTarget(connId)), authKey: "primary" },
      integrationId: PACKAGE_ID,
      manifest,
      authDef: manifest.auths!.primary as AfpsManifestAuth,
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      actor: { type: "user", id: ctx.user.id },
      force: true,
    });
    await expect(outcome).rejects.toMatchObject({
      status: 503,
      code: "encryption_key_unavailable",
    });
    expect(token.requests()).toBe(0);
  });
});

/** The connection as a resolver reads it: what a refresh is pinned to. */
async function readTarget(connId: string): Promise<RefreshTarget> {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      credentialsEncrypted: integrationConnections.credentialsEncrypted,
      clientRef: integrationConnections.clientRef,
      oauthResource: integrationConnections.oauthResource,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return row!;
}

async function fetchEncrypted(connId: string): Promise<string | null> {
  const [row] = await db
    .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return row?.credentialsEncrypted ?? null;
}

/**
 * Transient-refresh-failure escalation.
 *
 * `recordIntegrationRefreshFailure` increments a per-connection counter on
 * every transient (non-`invalid_grant`) refresh failure and flips
 * `needsReconnection` ONLY when the streak crosses the threshold AND the token
 * is already expired past the grace window — the silent-death case behind the
 * original Gmail scheduled-run incident. A successful credential write resets
 * the counter (via `persistCredentialBundle`).
 */
describe("integration refresh-failure escalation", () => {
  let ctx: TestContext;
  let token: TokenServer;
  const PACKAGE_ID = "@official/gmail";
  const HOUR_MS = 3_600_000;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "refresh-esc" });
    await seedPackage({
      id: PACKAGE_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
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
            token_endpoint: "https://idp/token",
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
      },
    });
    token = startTokenServer();
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
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function readRow(connId: string) {
    return db
      .select({
        refreshFailureCount: integrationConnections.refreshFailureCount,
        needsReconnection: integrationConnections.needsReconnection,
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

  it("a successful refresh resets the failure streak", async () => {
    // Seed an expired token with an accumulated streak (not yet escalated).
    const connId = await seedConn({
      expiresAt: new Date(Date.now() - 30 * 60_000),
      refreshFailureCount: 2,
    });
    // Expired → reReadFreshness does not short-circuit → doRefresh runs.
    token.setResponse({ access_token: "fresh-access", expires_in: 3600 });

    await forceRefreshIntegrationConnection(await readTarget(connId), PACKAGE_ID, "primary", {
      tokenEndpoint: token.url,
      clientId: "cid",
      clientSecret: "csec",
    });

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

    await expect(
      forceRefreshIntegrationConnection(await readTarget(connId), PACKAGE_ID, "primary", {
        tokenEndpoint: token.url,
        clientId: "cid",
        clientSecret: "csec",
      }),
    ).rejects.toThrow(/HTTP 200 without access_token/);

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

    const refused = forceRefreshIntegrationConnection(
      await readTarget(connId),
      PACKAGE_ID,
      "primary",
      { tokenEndpoint: token.url, clientId: "cid", clientSecret: "csec" },
    );
    await expect(refused).rejects.toBeInstanceOf(RefreshError);
    await expect(refused).rejects.toMatchObject({ kind: "revoked" });

    const row = await readRow(connId);
    expect(row.needsReconnection).toBe(true);
    expect(row.refreshFailureCount).toBe(1);
  });

  it("a transient upstream failure during refresh increments the counter and rethrows", async () => {
    const connId = await seedConn({ expiresAt: new Date(Date.now() - HOUR_MS) });
    token.setResponse({ error: "temporarily_unavailable" }, 503); // 5xx → transient

    await expect(
      forceRefreshIntegrationConnection(await readTarget(connId), PACKAGE_ID, "primary", {
        tokenEndpoint: token.url,
        clientId: "cid",
        clientSecret: "csec",
      }),
    ).rejects.toThrow();

    expect((await readRow(connId)).refreshFailureCount).toBe(1);
  });
});
