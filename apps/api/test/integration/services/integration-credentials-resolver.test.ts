// SPDX-License-Identifier: Apache-2.0

/**
 * Live integration credentials resolver (`resolveLiveIntegrationCredentials`).
 *
 * This is the sidecar `/internal/integration-credentials` backing: it decrypts
 * the per-run connection's credentials and proactively refreshes OAuth2 tokens.
 *
 * Refresh seam used by these tests
 * --------------------------------
 * The resolver does NOT take an injectable refresh function. It calls
 * `refreshConnectionCredential`, which in turn builds a
 * `RefreshContext` from the manifest's `auths.{key}.tokenUrl` + the seeded
 * per-space `integration_oauth_clients` row, then POSTs the
 * `refresh_token` to that token URL via the shared
 * `performRefreshTokenExchange`.
 *
 * So the lowest injectable boundary is the **token endpoint URL itself**:
 * each test stands up a controllable `Bun.serve` and points
 * `manifest.auths.primary.tokenUrl` at it. The server's response shape drives
 * the `RefreshError` taxonomy and the narrowed-grant path:
 *   - HTTP 400 + `{ "error": "invalid_grant" }` → RefreshError(kind="revoked") → 410
 *   - HTTP 500 (or any non-400)                 → RefreshError(kind="transient") → 502
 *   - HTTP 200 + narrowed `scope`               → stored grant narrowed, connection unflagged
 *
 * Refresh is triggered deterministically by a rejection trigger ({@link REJECTED}),
 * with no clock games for the lead window.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { integrationConnections, integrationOauthClients, packages } from "@appstrate/db/schema";
import { eq, sql } from "drizzle-orm";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import { resolveLiveIntegrationCredentials } from "../../../src/services/integration-credentials-resolver.ts";
import { resolveConnectionsForRun } from "../../../src/services/integration-connection-resolver.ts";
import {
  clearUpstreamRejections,
  readCredentialRevision,
  recordUnrefreshableRejection,
  saveIntegrationConnection,
} from "../../../src/services/integration-connections.ts";
import { getEnv } from "@appstrate/env";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEGRATION_ID = "@official/gmail";

/** An upstream 401 on the credential the connection holds. */
const REJECTED = { kind: "rejected", revision: null } as const;

/** A well-formed connection uuid that no row carries — for the pre-lookup refusals. */
const NO_SUCH_CONNECTION_ID = "00000000-0000-4000-8000-000000000000";

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
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(token.url),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION_ID);
    // Per-space OAuth client → makes the auth refreshable (buildIntegrationOAuthRefreshContext).
    const [oauthClient] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
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
    /** `false` seeds the "IdP never issued one" shape (no `access_type=offline`). */
    withRefreshToken?: boolean;
  }): Promise<string> {
    const ciphertext = encryptCredentialEnvelope({
      outputs: {
        access_token: "old-access",
        accessToken: "old-access",
        ...(opts.withRefreshToken === false ? {} : { refresh_token: "rt-1", refreshToken: "rt-1" }),
      },
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: opts.accountId ?? "acct-1",
        label: opts.accountId ?? "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: opts.userId ?? null,
        endUserId: opts.endUserId ?? null,
        credentialsEncrypted: ciphertext,
        scopesGranted: opts.scopes ?? ["read", "send"],
        // oauth2 connection → pins the org's custom per-space client by id (seeded above).
        clientRef: customClientId,
        ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /**
   * `connectionId` is REQUIRED on the resolver: a run binds a SET of
   * connections per integration and each credential read names one. Tests that
   * fail before the connection is ever read pass {@link NO_SUCH_CONNECTION_ID}.
   */
  function resolverContext(connectionId: string) {
    return {
      runId: "run_test",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      agentPackageId: "@creds/agent",
      actor: { type: "user" as const, id: ctx.user.id },
      connectionId,
      connectionSource: "member_pin",
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

    await expect(
      resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED),
    ).rejects.toMatchObject({
      status: 410,
      code: "integration_connection_needs_reconnection",
      extensions: { cause: "refresh_token_revoked" },
    });
    expect(await needsReconnection(connId)).toBe(true);
  });

  it("throws 502 and does NOT flag the connection on a transient refresh failure", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    token.setResponse({ error: "temporarily_unavailable" }, 500);

    await expect(
      resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED),
    ).rejects.toMatchObject({ status: 502, extensions: { cause: "upstream_transient" } });
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("throws 410 and flags the connection when this transient failure escalates the streak", async () => {
    const { INTEGRATION_REFRESH_MAX_FAILURES: max, INTEGRATION_REFRESH_GRACE_SECONDS: grace } =
      getEnv();
    const connId = await seedConnection({
      userId: ctx.user.id,
      expiresAt: new Date(Date.now() - (grace + 3600) * 1000),
    });
    await db
      .update(integrationConnections)
      .set({ refreshFailureCount: max - 1 })
      .where(eq(integrationConnections.id, connId));
    token.setResponse({ error: "temporarily_unavailable" }, 500);

    const refused = resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(connId),
      REJECTED,
    );
    await expect(refused).rejects.toMatchObject({
      status: 410,
      extensions: { cause: "refresh_failures_exhausted" },
    });
    expect(await needsReconnection(connId)).toBe(true);
  });

  it("does NOT flag an unrefreshable oauth2 auth on a PROACTIVE read (no forced refresh)", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    await db
      .delete(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, INTEGRATION_ID));

    // A read + the seeded token has no expiry → outside the lead
    // window → no refresh attempt → a still-valid token must NOT be flagged
    // merely because it lacks a refresh client.
    await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId));
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("a PROACTIVE read of a credential nothing can refresh, inside the lead window, serves it uncounted", async () => {
    async function refreshFailureCount(connId: string): Promise<number> {
      const [row] = await db
        .select({ count: integrationConnections.refreshFailureCount })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      return row!.count;
    }
    // Expiry 1 min out → inside OAUTH_REFRESH_LEAD_MS → the proactive branch runs.
    const soon = () => new Date(Date.now() + 60_000);

    // oauth2 whose minting client is gone.
    const oauthId = await seedConnection({ userId: ctx.user.id, expiresAt: soon() });
    await db
      .delete(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, INTEGRATION_ID));
    const oauth = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(oauthId));
    expect(oauth.auths[0]!.fields.access_token).toBe("old-access");
    expect(await refreshFailureCount(oauthId)).toBe(0);
    expect(await needsReconnection(oauthId)).toBe(false);

    // A non-oauth2 auth.
    await db
      .update(packages)
      .set({
        draftManifest: localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: { primary: { type: "api_key", credentialFields: ["api_key"] } },
        }) as unknown as Record<string, unknown>,
      })
      .where(eq(packages.id, INTEGRATION_ID));
    const apiKeyId = await seedConnection({
      userId: ctx.user.id,
      accountId: "acct-api-key",
      expiresAt: soon(),
    });
    await db
      .update(integrationConnections)
      .set({ clientRef: null })
      .where(eq(integrationConnections.id, apiKeyId));
    const apiKey = await resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(apiKeyId),
    );
    expect(apiKey.auths[0]!.fields.access_token).toBe("old-access");
    expect(await refreshFailureCount(apiKeyId)).toBe(0);
    expect(await needsReconnection(apiKeyId)).toBe(false);
  });

  // ── Invariant matrix ──
  // A FORCED refresh only happens after the sidecar saw an upstream 401. For
  // EVERY auth shape a real fleet uses, the outcome must be exactly one of:
  //   • refreshed → fresh token rotated in, connection NOT flagged; or
  //   • terminal  → 502 below the failure threshold (one rejection can be
  //     transient), then 410 + connection flagged needsReconnection.
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

      const forced = async () => {
        try {
          return {
            result: await resolveLiveIntegrationCredentials(
              INTEGRATION_ID,
              resolverContext(connId),
              REJECTED,
            ),
            status: undefined,
          };
        } catch (err) {
          return { result: undefined, status: (err as { status?: number }).status };
        }
      };

      if (c.expect === "flagged") {
        for (let i = 1; i < getEnv().INTEGRATION_REFRESH_MAX_FAILURES; i++) {
          expect((await forced()).status).toBe(502);
          expect(await needsReconnection(connId)).toBe(false);
        }
        expect((await forced()).status).toBe(410);
        expect(await needsReconnection(connId)).toBe(true);
      } else {
        const { result, status } = await forced();
        expect(status).toBeUndefined();
        expect(await needsReconnection(connId)).toBe(false);
        const primary = result!.auths.find((a) => a.authKey === "primary");
        // Genuinely rotated — NOT the seeded "old-access" → forbids silent no-op.
        expect(primary?.fields.access_token).toBe("rotated");
      }
    });
  }

  it("renders templated authorized_uris from the connection's fields (#1458)", async () => {
    await db
      .update(packages)
      .set({
        draftManifest: localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: {
            primary: {
              type: "api_key",
              authorizedUris: ["https://{$credential.host}/**", "https://static.example/**"],
              credentialFields: ["api_key", "host"],
              requiredCredentialFields: ["api_key", "host"],
            },
          },
        }) as unknown as Record<string, unknown>,
      })
      .where(eq(packages.id, INTEGRATION_ID));
    const [conn] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        label: "Connexion 1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { api_key: "k", host: "tenant.example.com" },
        }),
      })
      .returning({ id: integrationConnections.id });

    const result = await resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(conn!.id),
    );
    expect(result.auths[0]!.authorizedUris).toEqual([
      "https://tenant.example.com/**",
      "https://static.example/**",
    ]);
  });

  it("renders authorized_uris and the delivery value from the connection's variables (§7.12)", async () => {
    await db
      .update(packages)
      .set({
        draftManifest: {
          ...(localIntegrationManifest({
            name: INTEGRATION_ID,
            serverName: "@official/gmail-server",
            auths: {
              primary: {
                type: "api_key",
                authorizedUris: ["{$variable.base_url}/api/v4/**"],
                credentialFields: ["api_key"],
                delivery: {
                  http: {
                    in: "header",
                    name: "X-Forge-Key",
                    value: "{$variable.base_url}|{$credential.api_key}",
                  },
                },
              },
            },
          }) as unknown as Record<string, unknown>),
          variables: {
            schema: {
              type: "object",
              properties: { base_url: { type: "string" } },
              required: ["base_url"],
            },
          },
        },
      })
      .where(eq(packages.id, INTEGRATION_ID));
    const [conn] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        label: "Connexion 1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        variables: { base_url: "https://forge.example.com/" },
      })
      .returning({ id: integrationConnections.id });

    const result = await resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(conn!.id),
    );
    expect(result.auths[0]!.authorizedUris).toEqual(["https://forge.example.com/api/v4/**"]);
    expect(result.deliveryPlans.primary?.value).toBe("https://forge.example.com/|k");
  });

  it("a reconnect resets the rejection count of an unrefreshable auth", async () => {
    await db
      .update(packages)
      .set({
        draftManifest: localIntegrationManifest({
          name: INTEGRATION_ID,
          serverName: "@official/gmail-server",
          auths: { primary: { type: "api_key", credentialFields: ["api_key"] } },
        }) as unknown as Record<string, unknown>,
      })
      .where(eq(packages.id, INTEGRATION_ID));
    const connId = await seedConnection({ userId: ctx.user.id });
    const forced = () =>
      resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED).then(
        () => undefined,
        (err: { status?: number; message?: string }) => err,
      );
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 1; i < max; i++) expect((await forced())?.status).toBe(502);

    await saveIntegrationConnection(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        packageId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        credentials: { api_key: "fresh" },
        actor: { type: "user", id: ctx.user.id },
        connectionId: connId,
      },
    );
    // The count restarts from the reconnect, and the 502 says so.
    const afterReconnect = await forced();
    expect(afterReconnect).toMatchObject({ status: 502, extensions: { cause: "unrefreshable" } });
    expect(afterReconnect?.message).toContain(
      `1/${max} consecutive upstream rejections before it is flagged`,
    );
    expect(await needsReconnection(connId)).toBe(false);
  });

  describe("rejections of an unrefreshable auth count as a streak a success ends", () => {
    async function apiKeyConnection() {
      await db
        .update(packages)
        .set({
          draftManifest: localIntegrationManifest({
            name: INTEGRATION_ID,
            serverName: "@official/gmail-server",
            auths: { primary: { type: "api_key", credentialFields: ["api_key"] } },
          }) as unknown as Record<string, unknown>,
        })
        .where(eq(packages.id, INTEGRATION_ID));
      const connId = await seedConnection({ userId: ctx.user.id });
      // A non-OAuth2 connection has no minting client (`client_ref` invariant).
      await db
        .update(integrationConnections)
        .set({ clientRef: null })
        .where(eq(integrationConnections.id, connId));
      const forced = () =>
        resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED).then(
          () => undefined,
          (err: { status?: number; message?: string }) => err,
        );
      return { connId, forced };
    }

    async function storedCredential(connId: string) {
      const [row] = await db
        .select({
          ciphertext: integrationConnections.credentialsEncrypted,
          count: integrationConnections.refreshFailureCount,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      return row!;
    }

    /** A 2xx the platform relayed for the run's actor. */
    const succeed = (connId: string) =>
      clearUpstreamRejections(connId, INTEGRATION_ID, resolverContext(connId));

    /** What a reconnect leaves behind: another ciphertext, here with a streak of its own. */
    const replaceCredential = (connId: string, refreshFailureCount: number) =>
      db
        .update(integrationConnections)
        .set({
          credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "key-b" } }),
          refreshFailureCount,
        })
        .where(eq(integrationConnections.id, connId));

    it("a dead key rejected once per run, however far apart, is flagged on the threshold run", async () => {
      const { connId, forced } = await apiKeyConnection();
      const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
      for (let run = 1; run < max; run++) expect((await forced())?.status).toBe(502);
      expect(await forced()).toMatchObject({ status: 410, extensions: { cause: "unrefreshable" } });
      expect(await needsReconnection(connId)).toBe(true);
    });

    it("the threshold flag is the count's own: a credential written right after it is not flagged", async () => {
      const { connId, forced } = await apiKeyConnection();
      const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
      for (let run = 1; run < max; run++) await forced();
      // A reconnect landing between the counting write and anything that follows it.
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION test_reconnect_after_flag() RETURNS trigger AS $$
        BEGIN
          UPDATE integration_connections
            SET credentials_encrypted = 'reconnected', needs_reconnection = false,
                refresh_failure_count = 0
            WHERE id = NEW.id;
          RETURN NULL;
        END $$ LANGUAGE plpgsql`);
      await db.execute(sql`
        CREATE TRIGGER test_reconnect_after_flag AFTER UPDATE ON integration_connections
        FOR EACH ROW WHEN (NEW.needs_reconnection AND NEW.credentials_encrypted <> 'reconnected')
        EXECUTE FUNCTION test_reconnect_after_flag()`);
      try {
        expect((await forced())?.status).toBe(410);
      } finally {
        await db.execute(sql`DROP TRIGGER test_reconnect_after_flag ON integration_connections`);
        await db.execute(sql`DROP FUNCTION test_reconnect_after_flag()`);
      }
      expect((await storedCredential(connId)).ciphertext).toBe("reconnected");
      expect(await needsReconnection(connId)).toBe(false);
    });

    it("a healthy key with one provoked 401 per run, then successes, is never flagged", async () => {
      const { connId, forced } = await apiKeyConnection();
      const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
      for (let run = 0; run < 2 * max; run++) {
        const rejected = await forced();
        expect(rejected?.status).toBe(502);
        expect(rejected?.message).toContain(`1/${max} consecutive upstream rejections`);
        await succeed(connId);
      }
      expect(await needsReconnection(connId)).toBe(false);
    });

    it("the payload announces the streak of a non-OAuth2 connection until a success ends it", async () => {
      const { connId, forced } = await apiKeyConnection();
      const read = () => resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId));
      expect((await read()).rejectionStreak).toBeUndefined();
      await forced();
      await forced();
      expect((await read()).rejectionStreak).toBe(2);
      await succeed(connId);
      expect((await read()).rejectionStreak).toBeUndefined();
    });

    it("the payload names its credential revision, and a credential write changes it", async () => {
      const { connId } = await apiKeyConnection();
      const read = () => resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId));
      const before = (await read()).credentialRevision;
      expect(before).toMatch(/^[0-9a-f]{16}$/);
      expect((await read()).credentialRevision).toBe(before!);
      await replaceCredential(connId, 0);
      expect((await read()).credentialRevision).not.toBe(before!);
    });

    it("a 401 on a superseded credential counts nothing and hands back the current one", async () => {
      const { connId } = await apiKeyConnection();
      const held = (
        await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId))
      ).credentialRevision!;
      await replaceCredential(connId, 1);

      const current = await resolveLiveIntegrationCredentials(
        INTEGRATION_ID,
        resolverContext(connId),
        { kind: "rejected", revision: held },
      );
      expect(current.auths[0]!.fields.api_key).toBe("key-b");
      expect(current.credentialRevision).not.toBe(held);
      expect((await storedCredential(connId)).count).toBe(1);
    });

    it("a verdict from an actor who no longer reaches the connection changes nothing", async () => {
      const { connId } = await apiKeyConnection();
      await replaceCredential(connId, 2);
      const stranger = await createTestUser();
      const lostReach = {
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user" as const, id: stranger.id },
      };

      await clearUpstreamRejections(connId, INTEGRATION_ID, lostReach);
      expect((await storedCredential(connId)).count).toBe(2);
      const revision = (await readCredentialRevision(connId))!;
      expect(await recordUnrefreshableRejection(connId, INTEGRATION_ID, lostReach, revision)).toBe(
        null,
      );
      expect((await storedCredential(connId)).count).toBe(2);
    });

    it("a success leaves a flagged connection's count alone", async () => {
      const { connId } = await apiKeyConnection();
      await db
        .update(integrationConnections)
        .set({ refreshFailureCount: 3, needsReconnection: true })
        .where(eq(integrationConnections.id, connId));
      await succeed(connId);
      expect((await storedCredential(connId)).count).toBe(3);
    });

    it("a success leaves an OAuth2 connection's refresh-failure count alone", async () => {
      const connId = await seedConnection({ userId: ctx.user.id });
      await db
        .update(integrationConnections)
        .set({ clientRef: "system-client", refreshFailureCount: 3 })
        .where(eq(integrationConnections.id, connId));
      await succeed(connId);
      const [row] = await db
        .select({ count: integrationConnections.refreshFailureCount })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      expect(row!.count).toBe(3);
    });
  });

  it("forced refresh reaches the IdP even when the stored token is far from expiry", async () => {
    // The matrix above seeds connections with a NULL `expires_at`, so it never
    // exercised the freshness short-circuit. This is the shape that broke: a
    // token issued 10:00/expiring 11:00 and revoked upstream at 10:05. At 10:10
    // the sidecar's 401 forces a refresh, the resolver decides to refresh — and
    // the flag stopped there. `dedupedRefresh`'s post-lock re-read saw 50
    // minutes of remaining lifetime, returned the revoked ciphertext as
    // `{status:"refreshed"}`, and `needs_reconnection` was never written, so
    // the banner / readiness gate / badge all read healthy for another 50 min.
    const connId = await seedConnection({
      userId: ctx.user.id,
      expiresAt: new Date(Date.now() + 50 * 60_000),
    });
    token.setResponse({ access_token: "rotated", expires_in: 3600 });

    const result = await resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(connId),
      REJECTED,
    );

    const primary = result.auths.find((a) => a.authKey === "primary");
    expect(primary?.fields.access_token).toBe("rotated");
    expect(await needsReconnection(connId)).toBe(false);
  });

  it("forced refresh of a connection with no stored refresh_token → 410 + flagged", async () => {
    // Terminal, and it must SAY so. The helper flagged the row and then
    // returned `{ fields: <the dead token> }` as a success, so the sidecar
    // re-injected the credential that had just 401'd and answered the run 200 —
    // contradicting both the flag it had written and the 410 contract.
    const connId = await seedConnection({ userId: ctx.user.id, withRefreshToken: false });
    // The IdP is reachable and would answer — proving the refusal comes from
    // the missing refresh_token, not from an upstream failure.
    token.setResponse({ access_token: "rotated", expires_in: 3600 });

    // Named for what it is — not a revocation, which would send an operator
    // hunting upstream for one that never happened.
    await expect(
      resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED),
    ).rejects.toMatchObject({ status: 410, extensions: { cause: "refresh_token_missing" } });
    expect(await needsReconnection(connId)).toBe(true);
  });

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

      // transient — NOT 410
      await expect(
        resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(connId), REJECTED),
      ).rejects.toMatchObject({ status: 502, extensions: { cause: "discovery_transient" } });
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

      // A read → proactive path.
      const result = await resolveLiveIntegrationCredentials(
        INTEGRATION_ID,
        resolverContext(connId),
      );
      const primary = result.auths.find((a) => a.authKey === "primary");
      expect(primary?.fields.access_token).toBe("old-access"); // cached, un-rotated
      expect(await needsReconnection(connId)).toBe(false);
    } finally {
      failing.stop();
    }
  });

  it("stores a narrowed grant unflagged; resolution refuses only the agent needing the dropped scope", async () => {
    const connId = await seedConnection({
      userId: ctx.user.id,
      scopes: ["read", "send", "delete"],
    });
    token.setResponse({ access_token: "new-access", expires_in: 3600, scope: "read send" });

    const out = await resolveLiveIntegrationCredentials(
      INTEGRATION_ID,
      resolverContext(connId),
      REJECTED,
    );
    expect(out.auths.find((a) => a.authKey === "primary")?.fields.access_token).toBe("new-access");
    const [row] = await db
      .select({
        scopesGranted: integrationConnections.scopesGranted,
        needsReconnection: integrationConnections.needsReconnection,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row).toEqual({ scopesGranted: ["read", "send"], needsReconnection: false });

    const resolveFor = (name: string, tools: string[]) =>
      resolveConnectionsForRun({
        agentManifest: agentManifest(name, tools),
        packageId: name,
        actor: { type: "user", id: ctx.user.id },
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      });
    const deleter = await resolveFor("@creds/agent-deleter", ["delete_message"]);
    expect(deleter.errors).toMatchObject([
      { code: "insufficient_scopes", connectionId: connId, missingScopes: ["delete"] },
    ]);
    const sender = await resolveFor("@creds/agent-sender", ["send_message"]);
    expect(sender.errors).toEqual([]);
    expect(sender.resolved[INTEGRATION_ID]?.map((c) => c.connectionId)).toEqual([connId]);
  });

  it("does not resolve another actor's connection — 404, never a silent empty payload", async () => {
    const other = await createTestUser();
    // The only connection belongs to a DIFFERENT user; it is not shared.
    const foreignId = await seedConnection({ userId: other.id, accountId: "other-acct" });

    // No force-refresh: we want to observe selection, not the refresh path.
    let err: unknown;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(foreignId));
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

  // A run binding TWO connections to one integration loses exactly the one that went away.
  it("loses only the deleted member of a bound set — its sibling still resolves", async () => {
    const kept = await seedConnection({ userId: ctx.user.id, accountId: "acct-kept" });
    const removed = await seedConnection({ userId: ctx.user.id, accountId: "acct-removed" });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, removed));

    let err: unknown;
    try {
      await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(removed));
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (e) {
      err = e;
    }
    expect((err as { status?: number }).status).toBe(404);
    // Naming the id is the whole point: with N bound connections, "no
    // connection for this integration" does not say which one to re-connect.
    expect((err as Error).message).toContain(removed);
    expect((err as Error).message).toContain("source 'member_pin'");

    // CONTROL — the sibling is untouched. A dead member must not black-hole
    // the credentials of the connections that are still live.
    const out = await resolveLiveIntegrationCredentials(INTEGRATION_ID, resolverContext(kept));
    expect(out.auths).toHaveLength(1);
    expect(out.auths[0]!.authKey).toBe("primary");
  });

  it("throws 404 when the integration is not installed in the space", async () => {
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
      await resolveLiveIntegrationCredentials(
        "@official/uninstalled",
        resolverContext(NO_SUCH_CONNECTION_ID),
      );
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(404);
  });

  it("throws 404 when the integration package does not exist", async () => {
    let status: number | undefined;
    try {
      await resolveLiveIntegrationCredentials(
        "@official/does-not-exist",
        resolverContext(NO_SUCH_CONNECTION_ID),
      );
      throw new Error("expected resolveLiveIntegrationCredentials to throw");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(404);
  });
});
