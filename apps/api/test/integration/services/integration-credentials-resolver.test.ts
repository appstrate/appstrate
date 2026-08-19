// SPDX-License-Identifier: Apache-2.0

/**
 * E2 — live integration credentials resolver (`resolveLiveIntegrationCredentials`).
 *
 * This is the sidecar `/internal/integration-credentials` backing: it decrypts
 * the per-run connection's credentials and proactively refreshes OAuth2 tokens.
 *
 * Refresh seam used by these tests
 * --------------------------------
 * The resolver does NOT take an injectable refresh function. It calls
 * `forceRefreshIntegrationConnection` directly, which in turn builds a
 * `RefreshContext` from the manifest's `auths.{key}.tokenUrl` + the seeded
 * per-application `integration_oauth_clients` row, then POSTs the
 * `refresh_token` to that token URL via the shared
 * `performRefreshTokenExchange`.
 *
 * So the lowest injectable boundary is the **token endpoint URL itself**:
 * each test stands up a controllable `Bun.serve` and points
 * `manifest.auths.primary.tokenUrl` at it. The server's response shape drives
 * the `RefreshError` taxonomy and the scope-shrink path:
 *   - HTTP 400 + `{ "error": "invalid_grant" }` → RefreshError(kind="revoked") → 410
 *   - HTTP 500 (or any non-400)                 → RefreshError(kind="transient") → 502
 *   - HTTP 200 + narrowed `scope`               → shrinkDetected → scope-floor check
 *
 * Refresh is triggered deterministically via `options.forceRefresh = true`
 * (no clock games needed for the lead window).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections, integrationOauthClients, packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import { resolveLiveIntegrationCredentials } from "../../../src/services/integration-credentials-resolver.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEGRATION_ID = "@official/gmail";

// ── Controllable upstream token endpoint ─────────────────────
interface TokenServer {
  /** Token endpoint URL (`{origin}/token`). */
  url: string;
  /** Issuer origin — set as a manifest `issuer` to exercise OIDC discovery. */
  origin: string;
  setResponse: (body: Record<string, unknown> | string, status?: number) => void;
  /** Toggle the well-known discovery doc — `false` simulates a discovery outage. */
  setDiscovery: (enabled: boolean) => void;
  stop: () => void;
}

function startTokenServer(): TokenServer {
  let nextBody: Record<string, unknown> | string = {};
  let nextStatus = 200;
  let discoveryEnabled = true;
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
    fetch: (req) => {
      const u = new URL(req.url);
      // Serve an RFC 8414 / OIDC discovery doc on the well-known probes so an
      // issuer-only manifest can resolve its token_endpoint (the issuer member
      // MUST equal the configured issuer for the §7.3 equality check to pass).
      if (u.pathname.includes("/.well-known/")) {
        if (!discoveryEnabled) return new Response("not found", { status: 404 });
        const origin = `${u.protocol}//${u.host}`;
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
        });
      }
      return new Response(typeof nextBody === "string" ? nextBody : JSON.stringify(nextBody), {
        status: nextStatus,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}/token`,
    origin: `http://${server.hostname}:${server.port}`,
    setResponse: (body, status = 200) => {
      nextBody = body;
      nextStatus = status;
    },
    setDiscovery: (enabled) => {
      discoveryEnabled = enabled;
    },
    stop: () => server.stop(),
  };
}

function gmailManifest(tokenUrl: string): Record<string, unknown> {
  return {
    schema_version: "0.1",
    type: "integration",
    name: INTEGRATION_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.0.0" } },
    auths: {
      primary: {
        type: "oauth2",
        authorization_endpoint: "https://idp/a",
        token_endpoint: tokenUrl,
        token_endpoint_auth_method: "client_secret_post",
        authorized_uris: ["https://api/*"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
        scope_catalog: [
          { value: "read", label: "Read" },
          { value: "send", label: "Send" },
          { value: "delete", label: "Delete" },
        ],
      },
    },
    tools_policy: {
      list_messages: { required_scopes: { primary: ["read"] } },
      send_message: { required_scopes: { primary: ["send"] } },
      delete_message: { required_scopes: { primary: ["delete"] } },
    },
  };
}

function agentManifest(name: string, tools: string[]): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: name,
    dependencies: { integrations: { [INTEGRATION_ID]: "^1.0.0" } },
    integrations_configuration: { [INTEGRATION_ID]: { tools } },
  };
}

describe("resolveLiveIntegrationCredentials", () => {
  let ctx: TestContext;
  let token: TokenServer;
  let customClientId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "creds" });
    token = startTokenServer();
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(token.url),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEGRATION_ID);
    // Per-app OAuth client → makes the auth refreshable (buildIntegrationOAuthRefreshContext).
    const [oauthClient] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        clientId: "cid",
        clientSecretEncrypted: encryptCredentials({ client_secret: "csec" }),
      })
      .returning({ id: integrationOauthClients.id });
    customClientId = oauthClient!.id;
  });

  afterEach(() => {
    token.stop();
  });

  /** Seed a connection for the given owner with a refresh token + scopes. */
  async function seedConnection(opts: {
    userId?: string;
    endUserId?: string;
    scopes?: string[];
    accountId?: string;
    expiresAt?: Date;
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
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: opts.accountId ?? "acct-1",
        applicationId: ctx.defaultAppId,
        userId: opts.userId ?? null,
        endUserId: opts.endUserId ?? null,
        credentialsEncrypted: ciphertext,
        scopesGranted: opts.scopes ?? ["read", "send"],
        // oauth2 connection → pins the org's custom per-app client by id (seeded above).
        clientRef: customClientId,
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function resolverContext() {
    return {
      runId: "run_test",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      agentPackageId: "@creds/agent",
      actor: { type: "user" as const, id: ctx.user.id },
    };
  }

  async function needsReconnection(connId: string): Promise<boolean> {
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    return row!.needsReconnection;
  }

  it("throws 410 and flags needsReconnection when the refresh token is revoked", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    // RFC 6749 §5.2 revocation.
    token.setResponse({ error: "invalid_grant", error_description: "token revoked" }, 400);

    let status: number | undefined;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
        forceRefresh: true,
      });
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(410);
    expect(await needsReconnection(connId)).toBe(true);
  });

  it("throws 502 and does NOT flag the connection on a transient refresh failure", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    token.setResponse({ error: "temporarily_unavailable" }, 500);

    let status: number | undefined;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
        forceRefresh: true,
      });
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(502);
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("does NOT flag an unrefreshable oauth2 auth on a PROACTIVE read (no forced refresh)", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    await db
      .delete(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, INTEGRATION_ID));

    // No forceRefresh + the seeded token has no expiry → outside the lead
    // window → no refresh attempt → a still-valid token must NOT be flagged
    // merely because it lacks a refresh client.
    await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {});
    expect(await needsReconnection(connId)).toBe(false);
  });

  // ── Invariant matrix ──
  // A FORCED refresh only happens after the sidecar saw an upstream 401. For
  // EVERY auth shape a real fleet uses, the outcome must be exactly one of:
  //   • refreshed → fresh token rotated in, connection NOT flagged; or
  //   • terminal  → 410 + connection flagged needsReconnection.
  // It must NEVER be the old silent "stale-200, no flag" no-op (the original
  // bug). The `expect: "refreshed"` branch asserts the token was genuinely
  // ROTATED (not the seeded "old-access"), so a silent no-op fails both
  // branches and can never sneak back in for any shape in the grid.
  const OAUTH_DELIVERY = httpHeaderDelivery({
    name: "Authorization",
    prefix: "Bearer ",
    field: "access_token",
  });
  const FORCED_REFRESH_MATRIX: Array<{
    name: string;
    make: (t: TokenServer) => ReturnType<typeof localIntegrationManifest>;
    deleteClient?: boolean;
    expect: "refreshed" | "flagged";
  }> = [
    {
      name: "oauth2 explicit token_endpoint",
      make: (t) =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: {
            primary: {
              type: "oauth2",
              authorizationEndpoint: "https://idp/a",
              tokenEndpoint: t.url,
              tokenEndpointAuthMethod: "client_secret_post",
              delivery: OAUTH_DELIVERY,
            },
          },
        }),
      expect: "refreshed",
    },
    {
      name: "oauth2 issuer-only (OIDC discovery — Drive/OneDrive shape)",
      make: (t) =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: {
            primary: {
              type: "oauth2",
              issuer: t.origin,
              tokenEndpointAuthMethod: "client_secret_post",
              delivery: OAUTH_DELIVERY,
            },
          },
        }),
      expect: "refreshed",
    },
    {
      name: "oauth2 public client (token_endpoint_auth_method none)",
      make: (t) =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: {
            primary: {
              type: "oauth2",
              authorizationEndpoint: "https://idp/a",
              tokenEndpoint: t.url,
              tokenEndpointAuthMethod: "none",
              delivery: OAUTH_DELIVERY,
            },
          },
        }),
      expect: "refreshed",
    },
    {
      name: "oauth2 with no registered OAuth client",
      make: (t) =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: {
            primary: {
              type: "oauth2",
              authorizationEndpoint: "https://idp/a",
              tokenEndpoint: t.url,
              tokenEndpointAuthMethod: "client_secret_post",
              delivery: OAUTH_DELIVERY,
            },
          },
        }),
      deleteClient: true,
      expect: "flagged",
    },
    {
      name: "api_key",
      make: () =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: { primary: { type: "api_key", credentialFields: ["api_key"] } },
        }),
      expect: "flagged",
    },
    {
      name: "basic",
      make: () =>
        localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: { primary: { type: "basic", credentialFields: ["username", "password"] } },
        }),
      expect: "flagged",
    },
  ];

  for (const c of FORCED_REFRESH_MATRIX) {
    it(`forced refresh invariant — ${c.name} → ${c.expect}`, async () => {
      await db
        .update(packages)
        .set({ draftManifest: c.make(token) as unknown as Record<string, unknown> })
        .where(eq(packages.id, INTEGRATION_ID));
      if (c.deleteClient) {
        await db
          .delete(integrationOauthClients)
          .where(eq(integrationOauthClients.integrationId, INTEGRATION_ID));
      }
      const connId = await seedConnection({ userId: ctx.user.id });
      // OAuth refresh exchange (when reached) returns a rotated token.
      token.setResponse({ access_token: "rotated", expires_in: 3600 });

      let status: number | undefined;
      let result: Awaited<ReturnType<typeof resolveLiveIntegrationCredentials>> | undefined;
      try {
        result = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
          forceRefresh: true,
        });
      } catch (err) {
        status = (err as { status?: number }).status;
      }

      if (c.expect === "flagged") {
        expect(status).toBe(410);
        expect(await needsReconnection(connId)).toBe(true);
      } else {
        expect(status).toBeUndefined();
        expect(await needsReconnection(connId)).toBe(false);
        const primary = result!.auths.find((a) => a.authKey === "primary");
        // Genuinely rotated — NOT the seeded "old-access" → forbids silent no-op.
        expect(primary?.fields.access_token).toBe("rotated");
      }
    });
  }

  it("does NOT flag on a TRANSIENT token-endpoint discovery failure (issuer-only) — 502", async () => {
    // Major-regression guard: an issuer-only manifest (Drive/OneDrive shape)
    // whose discovery transiently fails must NOT be flagged needsReconnection —
    // a routine IdP blip would otherwise brick refresh for hourly-expiring
    // tokens. A fresh server (never-discovered issuer) with the well-known
    // probes 404'd models the outage; expect 502 + the connection row clean.
    const failing = startTokenServer();
    failing.setDiscovery(false);
    try {
      await db
        .update(packages)
        .set({
          draftManifest: localIntegrationManifest({
            name: INTEGRATION_ID,
            serverName: "@official/gmail-server",
            auths: {
              primary: {
                type: "oauth2",
                issuer: failing.origin,
                tokenEndpointAuthMethod: "client_secret_post",
                delivery: OAUTH_DELIVERY,
              },
            },
          }) as unknown as Record<string, unknown>,
        })
        .where(eq(packages.id, INTEGRATION_ID));
      const connId = await seedConnection({ userId: ctx.user.id });

      let status: number | undefined;
      try {
        await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
          forceRefresh: true,
        });
      } catch (err) {
        status = (err as { status?: number }).status;
      }
      expect(status).toBe(502); // transient — NOT 410
      expect(await needsReconnection(connId)).toBe(false); // row untouched
    } finally {
      failing.stop();
    }
  });

  it("PROACTIVE refresh: a discovery blip serves the cached token (no 502, no flag)", async () => {
    // Regression guard: on the lead-window (non-forced) path the cached token is
    // still valid — a discovery outage must NOT fail the run. The credential is
    // served unchanged and a later real 401 drives forced re-discovery.
    const failing = startTokenServer();
    failing.setDiscovery(false);
    try {
      await db
        .update(packages)
        .set({
          draftManifest: localIntegrationManifest({
            name: INTEGRATION_ID,
            serverName: "@official/gmail-server",
            auths: {
              primary: {
                type: "oauth2",
                issuer: failing.origin,
                tokenEndpointAuthMethod: "client_secret_post",
                delivery: OAUTH_DELIVERY,
              },
            },
          }) as unknown as Record<string, unknown>,
        })
        .where(eq(packages.id, INTEGRATION_ID));
      // Expiry 1 min out → inside OAUTH_REFRESH_LEAD_MS → proactive refresh fires.
      const connId = await seedConnection({
        userId: ctx.user.id,
        expiresAt: new Date(Date.now() + 60_000),
      });

      // No forceRefresh → proactive path.
      const result = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {});
      const primary = result.auths.find((a) => a.authKey === "primary");
      expect(primary?.fields.access_token).toBe("old-access"); // cached, un-rotated
      expect(await needsReconnection(connId)).toBe(false);
    } finally {
      failing.stop();
    }
  });

  it("flips needsReconnection when a scope shrink drops below the installed-agent floor", async () => {
    // Agent requires `delete`; the refresh narrows the grant to read+send only.
    await seedPackage({
      id: "@creds/agent-deleter",
      orgId: ctx.orgId,
      type: "agent",
      draftManifest: agentManifest("@creds/agent-deleter", ["delete_message"]),
    });
    await installPackage(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      "@creds/agent-deleter",
    );
    const connId = await seedConnection({
      userId: ctx.user.id,
      scopes: ["read", "send", "delete"],
    });
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read send" });

    const out = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
      forceRefresh: true,
    });
    // Credentials still resolve (the refresh succeeded) ...
    expect(out.auths.length).toBe(1);
    // ... but the connection is flagged because `delete` is now missing.
    expect(await needsReconnection(connId)).toBe(true);
  });

  it("absorbs a scope shrink silently when it still covers the required floor", async () => {
    // Agent requires only `read`; the refresh shrinks delete away but keeps read.
    await seedPackage({
      id: "@creds/agent-reader",
      orgId: ctx.orgId,
      type: "agent",
      draftManifest: agentManifest("@creds/agent-reader", ["list_messages"]),
    });
    await installPackage(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      "@creds/agent-reader",
    );
    const connId = await seedConnection({
      userId: ctx.user.id,
      scopes: ["read", "send", "delete"],
    });
    // Shrinks delete+send away but keeps read (the required floor).
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read" });

    const out = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(), {
      forceRefresh: true,
    });
    expect(out.auths.length).toBe(1);
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("does not resolve another actor's connection — 404, never a silent empty payload", async () => {
    const other = await createTestUser();
    // The only connection belongs to a DIFFERENT user; it is not shared.
    const foreignId = await seedConnection({ userId: other.id, accountId: "other-acct" });

    // No force-refresh: we want to observe selection, not the refresh path.
    let err: unknown;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext());
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (e) {
      err = e;
    }
    // The foreign row is never decrypted and never returned (no cross-actor
    // leak) — but "no accessible connection" is now a LOUD 404 rather than the
    // empty payload, which the sidecar read as "this integration declares no
    // auth, skip the MITM listener" and booted the run uncredentialed.
    expect((err as { status?: number }).status).toBe(404);
    expect((err as Error).message).not.toContain("other-acct");
    // The other actor's connection is untouched — a failed lookup must never
    // flag a row that belongs to someone else.
    expect(await needsReconnection(foreignId)).toBe(false);
  });

  it("throws 409 integration_auth_undeclared when the pinned manifest dropped the connection's auth", async () => {
    // STATE B — the row decrypts fine, but the manifest VERSION this run reads
    // no longer declares the auth it was created against (renamed/removed).
    // Reached via the run's `resolved_connections` pin: that is the only
    // selection path that returns a row whose authKey is outside the declared
    // set. Without the declaration there is no delivery plan and no
    // `authorized_uris`, so nothing can be injected.
    const connId = await seedConnection({ userId: ctx.user.id });
    await db
      .update(integrationConnections)
      .set({ authKey: "legacy_primary" })
      .where(eq(integrationConnections.id, connId));

    let err: unknown;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, {
        ...resolverContext(),
        resolvedConnections: { [INTEGRATION_ID]: { connectionId: connId, source: "member_pin" } },
      });
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (e) {
      err = e;
    }
    expect((err as { status?: number }).status).toBe(409);
    expect((err as { code?: string }).code).toBe("integration_auth_undeclared");
    // Names the undeclared key AND what the manifest does declare.
    expect((err as Error).message).toContain("legacy_primary");
    expect((err as Error).message).toContain("primary");
    // NOT flagged: the credential is intact and may be valid under another
    // manifest version. A manifest edit must not destroy a working connection.
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("throws 410 and flags when the stored credentials cannot be decrypted (unforced read)", async () => {
    // STATE C — a rotated `CONNECTION_ENCRYPTION_KEY` or a corrupted blob. A
    // credential nobody can read is dead on ANY read, so this is terminal even
    // without a forced refresh: flag the row, refuse loudly.
    const connId = await seedConnection({ userId: ctx.user.id });
    await db
      .update(integrationConnections)
      .set({ credentialsEncrypted: "v1:not-a-real-envelope" })
      .where(eq(integrationConnections.id, connId));

    let err: unknown;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext());
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (e) {
      err = e;
    }
    expect((err as { status?: number }).status).toBe(410);
    expect((err as { code?: string }).code).toBe("INTEGRATION_CONNECTION_NEEDS_RECONNECTION");
    expect((err as Error).message).toMatch(/could not be decrypted/i);
    expect(await needsReconnection(connId)).toBe(true);
  });

  // NOTE — the resolver's ONE legitimate empty payload (an integration that
  // declares no auth) is deliberately untested here: it is unreachable through
  // a stored manifest. `@afps-spec/schema` requires at least one auth method,
  // so a zero-auth manifest fails validation in `loadIntegrationManifest` and
  // the resolver throws 500 before reaching the branch. It is kept in the
  // source as the correct answer if that rule ever relaxes — and as the
  // reference the three fail-loud states above are contrasted against.

  it("throws 404 when the integration is not installed in the application", async () => {
    // A different integration the agent never declared / installed.
    await seedPackage({
      id: "@official/uninstalled",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(token.url),
    });

    let status: number | undefined;
    try {
      await resolveLiveIntegrationCredentials("@official/uninstalled", resolverContext());
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(404);
  });

  it("throws 404 when the integration package does not exist", async () => {
    let status: number | undefined;
    try {
      await resolveLiveIntegrationCredentials("@official/does-not-exist", resolverContext());
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(404);
  });
});
