// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-time guard against born-dead OAuth2 connections.
 *
 * A short-lived access token (`expires_at` set) returned with NO
 * `refresh_token` is unrenewable: it 401s within the hour and can never
 * self-refresh, silently bricking the connection and every schedule on it
 * (the original `@appstrate/gmail` self-disconnect — manifest missing
 * `access_type=offline`). `OAuth2Strategy.complete` refuses it BEFORE
 * persistence, provider-agnostic.
 *
 * Re-auth carry-forward: when an IdP omits `refresh_token` on re-consent
 * (e.g. Google without `prompt=consent`), the update path preserves the
 * still-valid stored token instead of clobbering it with none.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import { integrationConnections } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import type { Actor } from "@appstrate/connect";
import type { IntegrationOAuthCallbackResult } from "@appstrate/connect";

const INTEGRATION = "@orga/oauthtest";

const MANIFEST = {
  name: INTEGRATION,
  version: "1.0.0",
  type: "integration",
  schema_version: "0.1",
  source: { kind: "none" },
  auths: {
    primary: {
      type: "oauth2",
      authorization_endpoint: "https://idp.example.com/authorize",
      token_endpoint: "https://idp.example.com/token",
      authorized_uris: ["https://api.example.com/**"],
      delivery: {
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer",
          value: "{$credential.access_token}",
        },
      },
    },
  },
} as const;

describe("integration OAuth2 — refresh_token connect-time guard", () => {
  let ctx: TestContext;
  let actor: Actor;
  let strategy: OAuth2Strategy;
  let connectCtx: ConnectContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    actor = { type: "user", id: ctx.user.id };
    strategy = new OAuth2Strategy();
    connectCtx = {
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      actor,
      integrationId: INTEGRATION,
      authKey: "primary",
    };
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: MANIFEST as unknown as Record<string, unknown>,
    });
  });

  function result(
    over: Partial<IntegrationOAuthCallbackResult> = {},
  ): IntegrationOAuthCallbackResult {
    return {
      packageId: INTEGRATION,
      authKey: "primary",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor,
      accessToken: "at-1",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopesGranted: [],
      scopeShortfall: [],
      scopeCreep: [],
      tokenResponse: { access_token: "at-1", expires_in: 3600 },
      ...over,
    };
  }

  const complete = (r: IntegrationOAuthCallbackResult, connectionId?: string) =>
    strategy.complete(connectionId ? { ...connectCtx, connectionId } : connectCtx, {
      kind: "oauth2-result",
      result: { ...r, ...(connectionId ? { connectionId } : {}) },
    });

  async function storedRefreshToken(connectionId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    return row ? decryptCredentialsToStringMap(row.credentialsEncrypted).refresh_token : undefined;
  }

  it("rejects a short-lived token with no refresh_token (insert) — born dead", async () => {
    await expect(complete(result({ refreshToken: undefined }))).rejects.toThrow(/refresh token/i);
    const rows = await db.select().from(integrationConnections);
    expect(rows.length).toBe(0); // nothing persisted
  });

  it("persists when a refresh_token is present", async () => {
    const conn = await complete(result({ refreshToken: "rt-1" }));
    expect(await storedRefreshToken(conn.id)).toBe("rt-1");
  });

  it("allows a long-lived token (no expires_at) with no refresh_token", async () => {
    // Token never expires → nothing to refresh → guard must not fire.
    const conn = await complete(result({ expiresAt: null, refreshToken: undefined }));
    expect(await storedRefreshToken(conn.id)).toBeUndefined();
  });

  it("re-auth without a refresh_token preserves the stored one (no clobber)", async () => {
    const created = await complete(result({ refreshToken: "rt-keep" }));
    expect(await storedRefreshToken(created.id)).toBe("rt-keep");

    // Re-consent returns only a fresh access token, no refresh_token.
    const reconnected = await complete(
      result({ accessToken: "at-2", refreshToken: undefined }),
      created.id,
    );
    expect(reconnected.id).toBe(created.id);
    // Stored refresh_token survives — connection stays refreshable.
    expect(await storedRefreshToken(created.id)).toBe("rt-keep");
  });

  // ── AS-capability-aware softening (MCP-spec refresh) ──────────────────────
  // The base MANIFEST declares explicit endpoints with NO issuer, so capability
  // is unknown → strict default (refuse), exercised by the tests above. These
  // two cover an issuer-declaring auth where RFC 8414 `grant_types_supported`
  // tells us whether a missing refresh token is expected or a misconfig.

  function issuerManifest(id: string, issuer: string): Record<string, unknown> {
    return {
      name: id,
      version: "1.0.0",
      type: "integration",
      schema_version: "0.1",
      source: { kind: "remote", remote: { url: `${issuer}/mcp`, transport: "streamable-http" } },
      auths: {
        primary: {
          type: "oauth2",
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          token_endpoint_auth_method: "none",
          authorized_uris: [`${issuer}/**`],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer",
              value: "{$credential.access_token}",
            },
          },
        },
      },
    };
  }

  /**
   * Run `fn` with global fetch stubbed to serve an RFC 8414 discovery document
   * for `issuer` advertising the given `grant_types_supported`. A distinct
   * issuer per test keeps the per-issuer discovery cache from bleeding across
   * cases. Only the well-known is served; no userinfo_endpoint, so `complete`
   * skips the userinfo fetch.
   */
  async function withDiscovery<T>(
    issuer: string,
    grantTypesSupported: string[] | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/.well-known/")) {
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            ...(grantTypesSupported ? { grant_types_supported: grantTypesSupported } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;
    return fn().finally(() => {
      globalThis.fetch = orig;
    });
  }

  it("persists a short-lived no-refresh token when the AS advertises no refresh_token grant (ClickUp MCP)", async () => {
    const id = "@orga/mcp-norefresh";
    const issuer = "https://mcp-norefresh.example";
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: issuerManifest(id, issuer),
    });
    const conn = await withDiscovery(issuer, ["authorization_code"], () =>
      strategy.complete(
        { ...connectCtx, integrationId: id },
        {
          kind: "oauth2-result",
          result: { ...result({ refreshToken: undefined }), packageId: id },
        },
      ),
    );
    // Persisted (not refused), no refresh token — re-auth happens at expiry.
    expect(await storedRefreshToken(conn.id)).toBeUndefined();
    expect((await db.select().from(integrationConnections)).length).toBe(1);
  });

  it("still refuses a short-lived no-refresh token when the AS DOES advertise the refresh_token grant", async () => {
    const id = "@orga/mcp-refreshcapable";
    const issuer = "https://mcp-refresh.example";
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: issuerManifest(id, issuer),
    });
    await expect(
      withDiscovery(issuer, ["authorization_code", "refresh_token"], () =>
        strategy.complete(
          { ...connectCtx, integrationId: id },
          {
            kind: "oauth2-result",
            result: { ...result({ refreshToken: undefined }), packageId: id },
          },
        ),
      ),
    ).rejects.toThrow(/refresh token/i);
    expect((await db.select().from(integrationConnections)).length).toBe(0);
  });
});
