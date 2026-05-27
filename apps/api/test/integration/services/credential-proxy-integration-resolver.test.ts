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
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  resolveIntegrationProxyCredentials,
  forceRefreshIntegrationProxyCredentials,
  IntegrationCredentialNotFoundError,
  IntegrationCredentialRevokedError,
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
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, INTEGRATION_ID);
    await db.insert(integrationOauthClients).values({
      applicationId: ctx.defaultAppId,
      integrationId: INTEGRATION_ID,
      authKey: "primary",
      clientId: "cid",
      clientSecretEncrypted: encryptCredentials({ client_secret: "csec" }),
    });
  });

  afterEach(() => {
    token.stop();
  });

  async function seedConnection(opts: { userId?: string; endUserId?: string }): Promise<string> {
    const ciphertext = encryptCredentials({
      access_token: "live-access",
      accessToken: "live-access",
      refresh_token: "rt-1",
      refreshToken: "rt-1",
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: opts.userId ?? null,
        endUserId: opts.endUserId ?? null,
        credentialsEncrypted: ciphertext,
        scopesGranted: ["read"],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function input(actorId = ctx.user.id) {
    return {
      integrationId: INTEGRATION_ID,
      applicationId: ctx.defaultAppId,
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
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, NO_AUTH);

    await expect(
      resolveIntegrationProxyCredentials({ ...input(), integrationId: NO_AUTH }),
    ).rejects.toBeInstanceOf(IntegrationCredentialNotFoundError);
  });

  it("throws IntegrationCredentialRevokedError on a revoked refresh token (force-refresh path)", async () => {
    await seedConnection({ userId: ctx.user.id });
    token.setResponse({ error: "invalid_grant", error_description: "revoked" }, 400);

    await expect(forceRefreshIntegrationProxyCredentials(input())).rejects.toBeInstanceOf(
      IntegrationCredentialRevokedError,
    );
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
