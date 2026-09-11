// SPDX-License-Identifier: Apache-2.0

/**
 * E1 — credential-proxy integration resolver
 * (`resolveIntegrationProxyCredentials` / `forceRefreshIntegrationProxyCredentials`).
 *
 * Backs the external-runner `POST /api/credential-proxy/proxy` endpoint.
 * `resolveIntegrationProxyCredentials` is the read path (no refresh);
 * `forceRefreshIntegrationProxyCredentials` is the reactive 401-retry path that
 * force-refreshes the OAuth2 token.
 *
 * Refresh seam: same as the live-credentials resolver — neither function takes
 * an injectable refresh function. The refresh goes through
 * `forceRefreshIntegrationConnection` → `performRefreshTokenExchange`, which
 * POSTs to the manifest's `auths.{key}.tokenUrl`. We point that URL at a
 * controllable `Bun.serve` and seed an `integration_oauth_clients` row so the
 * `RefreshContext` builds; the server returns
 * `{ "error": "invalid_grant" }` (HTTP 400) to drive the revoked path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { integrationConnections, integrationOauthClients, packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { encryptCredentialEnvelope, encryptCredentials } from "@appstrate/connect";
import {
  resolveIntegrationProxyCredentials,
  forceRefreshIntegrationProxyCredentials,
  IntegrationCredentialNotFoundError,
} from "../../../src/services/credential-proxy/integration-resolver.ts";

const INTEGRATION_ID = "@official/gmail";

interface TokenServer {
  url: string;
  setResponse: (body: Record<string, unknown>, status?: number) => void;
  stop: () => void;
}

function startTokenServer(): TokenServer {
  let nextBody: Record<string, unknown> = {};
  let nextStatus = 200;
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
    fetch: () =>
      new Response(JSON.stringify(nextBody), {
        status: nextStatus,
        headers: { "Content-Type": "application/json" },
      }),
  });
  return {
    url: `http://${server.hostname}:${server.port}/token`,
    setResponse: (body, status = 200) => {
      nextBody = body;
      nextStatus = status;
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
        authorized_uris: ["https://api.example.com/*"],
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
  };
}

describe("credential-proxy integration-resolver", () => {
  let ctx: TestContext;
  let token: TokenServer;
  let customClientId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cproxy" });
    token = startTokenServer();
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(token.url),
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION_ID);
    const [oauthClient] = await db
      .insert(integrationOauthClients)
      .values({
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

  async function seedConnection(opts: {
    userId?: string;
    endUserId?: string;
    /** `false` seeds the "IdP never issued one" shape (no `access_type=offline`). */
    withRefreshToken?: boolean;
  }): Promise<string> {
    const ciphertext = encryptCredentialEnvelope({
      outputs: {
        access_token: "live-access",
        accessToken: "live-access",
        ...(opts.withRefreshToken === false ? {} : { refresh_token: "rt-1", refreshToken: "rt-1" }),
      },
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: opts.userId ?? null,
        endUserId: opts.endUserId ?? null,
        credentialsEncrypted: ciphertext,
        scopesGranted: ["read"],
        // oauth2 connection → pins the org's custom per-space client by id (seeded above).
        clientRef: customClientId,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function input(actorId = ctx.user.id) {
    return {
      integrationId: INTEGRATION_ID,
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      actor: { type: "user" as const, id: actorId },
    };
  }

  it("resolves a proxy credentials payload for a seeded connection (happy path)", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });

    const resolved = await resolveIntegrationProxyCredentials(input());
    expect(resolved.connectionId).toBe(connId);
    expect(resolved.authKey).toBe("primary");
    expect(resolved.payload).toBeDefined();
    // The live access token must reach the payload (header injection input).
    expect(JSON.stringify(resolved.payload)).toContain("live-access");
  });

  it("throws IntegrationCredentialNotFoundError when no accessible connection exists", async () => {
    // Integration installed + declares auths, but no connection seeded.
    await expect(resolveIntegrationProxyCredentials(input())).rejects.toBeInstanceOf(
      IntegrationCredentialNotFoundError,
    );
  });

  it("throws IntegrationCredentialNotFoundError when the integration declares no auth methods", async () => {
    const NO_AUTH = "@official/noauth";
    await seedPackage({
      id: NO_AUTH,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
        schema_version: "0.1",
        type: "integration",
        name: NO_AUTH,
        version: "1.0.0",
        display_name: "NoAuth",
        source: { kind: "local", server: { name: "@official/noauth-server", version: "^1.0.0" } },
        auths: {
          primary: {
            type: "api_key",
            authorized_uris: ["https://api.example.com/*"],
            credentials: {
              schema: { type: "object", properties: { api_key: { type: "string" } } },
            },
            delivery: {
              http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
            },
          },
        },
      },
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, NO_AUTH);

    await expect(
      resolveIntegrationProxyCredentials({ ...input(), integrationId: NO_AUTH }),
    ).rejects.toBeInstanceOf(IntegrationCredentialNotFoundError);
  });

  it("returns null and flags needsReconnection on a revoked refresh token (force-refresh path)", async () => {
    const connId = await seedConnection({ userId: ctx.user.id });
    token.setResponse({ error: "invalid_grant", error_description: "revoked" }, 400);

    // Not-refreshed, like the other terminal shape: the caller (inside
    // `catch {}` either way) relays the upstream 401, and the persisted flag
    // is what makes the failure legible.
    expect(await forceRefreshIntegrationProxyCredentials(input())).toBeNull();
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(true);
  });

  it("returns null (never the dead token) when the connection has no refresh_token", async () => {
    // The row is already flagged in this shape — what was wrong is that the
    // refresh reported SUCCESS carrying the very access_token that just 401'd,
    // so the proxy rebuilt a payload from it and retried with an identical
    // credential. Terminal in, terminal out.
    const connId = await seedConnection({ userId: ctx.user.id, withRefreshToken: false });
    // A working token endpoint: the refusal must come from the missing
    // refresh_token, not from an upstream failure.
    token.setResponse({ access_token: "rotated", expires_in: 3600 });

    expect(await forceRefreshIntegrationProxyCredentials(input())).toBeNull();
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(true);
  });

  it("returns null (keeps the original 401) on a transient token-endpoint discovery failure", async () => {
    // Issuer-only manifest (Drive/OneDrive shape) whose discovery fails (the
    // server returns a non-matching doc on every well-known probe). The forced
    // path must NOT throw — it returns null so the route keeps the original 401
    // and the connection row is untouched (mirrors the main resolver's 502, but
    // this surface degrades to not-refreshed rather than erroring).
    const origin = token.url.replace(/\/token$/, "");
    const issuerOnly = gmailManifest(token.url);
    (issuerOnly.auths as Record<string, Record<string, unknown>>).primary = {
      type: "oauth2",
      issuer: origin,
      token_endpoint_auth_method: "client_secret_post",
      authorized_uris: ["https://api.example.com/*"],
      delivery: {
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer ",
          value: "{$credential.access_token}",
        },
      },
    };
    await db
      .update(packages)
      .set({ draftManifest: issuerOnly })
      .where(eq(packages.id, INTEGRATION_ID));
    const connId = await seedConnection({ userId: ctx.user.id });
    token.setResponse({ not: "a discovery doc" }); // well-known probes → no issuer match

    expect(await forceRefreshIntegrationProxyCredentials(input())).toBeNull();
    // `null` alone no longer discriminates transient from terminal: both
    // shapes return it since `IntegrationCredentialRevokedError` was removed,
    // so the PERSISTED flag is the only thing left that tells them apart. The
    // comment above claims "the connection row is untouched" — assert it, or a
    // regression that flags a healthy connection on a transient discovery
    // outage (forcing a needless user reconnect) passes silently.
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(false);
  });

  it("flags needsReconnection when the minting OAuth client is gone (terminal, not transient)", async () => {
    // `buildIntegrationOAuthRefreshContext` returns null for a set of TERMINAL
    // conditions — deleted OAuth client, missing `client_ref`, undecryptable
    // client secret, no token endpoint and no issuer to discover one from.
    // Nothing will ever refresh this token again. The sidecar path flags the
    // connection here (`flagTerminalAndThrow` → 410); this path used to just
    // `return null`, so CLI / GitHub Action / self-hosted-runner users looped
    // on 401 forever with no reconnect prompt anywhere.
    const connId = await seedConnection({ userId: ctx.user.id });
    await db
      .delete(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, INTEGRATION_ID));

    // Still null — the proxy must relay the upstream 401 rather than
    // substitute its own error — but the row is now marked.
    expect(await forceRefreshIntegrationProxyCredentials(input())).toBeNull();

    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(true);
  });

  it("does NOT flag on a transient token-endpoint discovery failure", async () => {
    // Control for the test above: transient must stay category-3 (nothing
    // persisted, retry later). Flagging here would brick a live connection on
    // a routine IdP blip.
    const origin = token.url.replace(/\/token$/, "");
    const issuerOnly = gmailManifest(token.url);
    (issuerOnly.auths as Record<string, Record<string, unknown>>).primary = {
      type: "oauth2",
      issuer: origin,
      token_endpoint_auth_method: "client_secret_post",
      authorized_uris: ["https://api.example.com/*"],
      delivery: {
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer ",
          value: "{$credential.access_token}",
        },
      },
    };
    await db
      .update(packages)
      .set({ draftManifest: issuerOnly })
      .where(eq(packages.id, INTEGRATION_ID));
    const connId = await seedConnection({ userId: ctx.user.id });
    token.setResponse({ not: "a discovery doc" }); // well-known probes → no issuer match

    expect(await forceRefreshIntegrationProxyCredentials(input())).toBeNull();

    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row!.needsReconnection).toBe(false);
  });

  it("does not resolve another actor's connection (actor isolation, never leaks B's credentials)", async () => {
    const other = await createTestUser();
    // Connection belongs to actor B (not shared). Actor A resolves.
    await seedConnection({ userId: other.id });

    // Read path: A has no accessible connection → not-found, never B's payload.
    await expect(resolveIntegrationProxyCredentials(input(ctx.user.id))).rejects.toBeInstanceOf(
      IntegrationCredentialNotFoundError,
    );
    // Refresh path: A's force-refresh returns null (no accessible connection),
    // never touches/returns B's row.
    const refreshed = await forceRefreshIntegrationProxyCredentials(input(ctx.user.id));
    expect(refreshed).toBeNull();
  });
});
