// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6 — refresh-time scope-shrink awareness.
 *
 * `forceRefreshIntegrationConnection` is the inline refresh helper called
 * by the integration credentials resolver. Phase 6 added two behaviours:
 *
 *   1. When the IdP echoes a `scope` field in the refresh response,
 *      `scopes_granted` on the DB row is overwritten with the new
 *      authoritative set (OAuth 2 §5.1).
 *   2. The result surfaces `shrinkDetected = true` when the new set is
 *      strictly narrower than the previously-stored one, so the resolver
 *      can cross-check against installed agents' `requiredScopes` and
 *      flip `needsReconnection` if the actor dropped below the floor.
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
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { encryptCredentials } from "@appstrate/connect";
import { forceRefreshIntegrationConnection } from "../../../src/services/integration-token-refresh.ts";

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
        schema_version: "2.0",
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

  async function seedConnection(initialScopes: string[]): Promise<string> {
    const ciphertext = encryptCredentials({
      access_token: "old-access",
      accessToken: "old-access",
      refresh_token: "rt-1",
      refreshToken: "rt-1",
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationPackageId: PACKAGE_ID,
        authKey: "primary",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: ciphertext,
        scopesGranted: initialScopes,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("preserves scopesGranted when the refresh response omits `scope`", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({ access_token: "new-access", expires_in: 3600 });

    const result = await forceRefreshIntegrationConnection(
      connId,
      PACKAGE_ID,
      "primary",
      (await fetchEncrypted(connId))!,
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

  it("writes back scopesGranted unchanged when the IdP echoes the same set", async () => {
    const connId = await seedConnection(["read", "send"]);
    token.setResponse({
      access_token: "new-access",
      expires_in: 3600,
      scope: "read send",
    });

    const result = await forceRefreshIntegrationConnection(
      connId,
      PACKAGE_ID,
      "primary",
      (await fetchEncrypted(connId))!,
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
      connId,
      PACKAGE_ID,
      "primary",
      (await fetchEncrypted(connId))!,
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

  it("treats scope creep (response wider than stored) as non-shrink", async () => {
    const connId = await seedConnection(["read"]);
    token.setResponse({
      access_token: "new-access",
      expires_in: 3600,
      scope: "read send", // IdP added a scope the user previously had
    });

    const result = await forceRefreshIntegrationConnection(
      connId,
      PACKAGE_ID,
      "primary",
      (await fetchEncrypted(connId))!,
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
});

async function fetchEncrypted(connId: string): Promise<string | null> {
  const [row] = await db
    .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connId));
  return row?.credentialsEncrypted ?? null;
}
