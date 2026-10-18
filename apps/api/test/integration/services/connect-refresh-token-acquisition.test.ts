// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-token acquisition (`_meta["dev.appstrate/oauth"].acquisition: "refresh_token"`):
 * `OAuth2Strategy.complete` takes the submitted `fields`, exchanges the refresh token at the token
 * endpoint with the auth's default client — the exchange every later refresh runs — and persists
 * an ordinary oauth2 connection, or refuses before anything is stored.
 *
 * A Bun.serve stands in for the token endpoint and the userinfo endpoint; a public system client
 * (`token_endpoint_auth_method: "none"`) serves the auth, as for a mobile-app SSO.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import type { Actor } from "@appstrate/connect";
import { integrationConnections } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { initSystemIntegrations } from "../../../src/services/integration-client-registry.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";

const INTEGRATION = "@orga/rt-acquired";
const SYSTEM_CLIENT = "rt-acquired-sys";
const PUBLIC_CLIENT_ID = "PUBLIC_MOBILE_CLIENT";

interface Upstream {
  base: string;
  /** Next token-endpoint answer. */
  setToken: (body: Record<string, unknown>, status?: number) => void;
  /** The last token request: its form body and Authorization header. */
  lastTokenRequest: () => { form: Record<string, string>; authorization: string | null } | null;
  tokenRequests: () => number;
  stop: () => void;
}

function startUpstream(): Upstream {
  let tokenBody: Record<string, unknown> = {};
  let tokenStatus = 200;
  let last: { form: Record<string, string>; authorization: string | null } | null = null;
  let served = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        served += 1;
        last = {
          form: Object.fromEntries(new URLSearchParams(await req.text())),
          authorization: req.headers.get("authorization"),
        };
        return Response.json(tokenBody, { status: tokenStatus });
      }
      if (url.pathname === "/userinfo") {
        if (req.headers.get("authorization") !== "Bearer at-fresh") {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ profileId: 4242, displayName: "pierre-trek" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    base: `http://${server.hostname}:${server.port}`,
    setToken: (body, status = 200) => {
      tokenBody = body;
      tokenStatus = status;
    },
    lastTokenRequest: () => last,
    tokenRequests: () => served,
    stop: () => server.stop(true),
  };
}

function manifest(base: string): Record<string, unknown> {
  return {
    name: INTEGRATION,
    version: "1.0.0",
    type: "integration",
    schema_version: "0.1",
    source: { kind: "none" },
    auths: {
      primary: {
        type: "oauth2",
        authorization_endpoint: `${base}/sign-in`,
        token_endpoint: `${base}/token`,
        token_endpoint_auth_method: "none",
        userinfo_endpoint: `${base}/userinfo`,
        identity_claims: { account_id: "$.displayName", profile_id: "$.profileId" },
        authorized_uris: ["https://api.example.com/**"],
        credentials: {
          schema: {
            type: "object",
            properties: { refresh_token: { type: "string" } },
            required: ["refresh_token"],
          },
        },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
        _meta: {
          "dev.appstrate/oauth": {
            acquisition: "refresh_token",
            refresh_token_issuance: "default",
          },
        },
      },
    },
  };
}

describe("OAuth2Strategy — refresh-token acquisition", () => {
  let ctx: TestContext;
  let actor: Actor;
  let connectCtx: ConnectContext;
  let upstream: Upstream;
  const strategy = new OAuth2Strategy();

  beforeEach(async () => {
    await truncateAll();
    upstream = startUpstream();
    ctx = await createTestContext({ orgSlug: "orga" });
    actor = { type: "user", id: ctx.user.id };
    connectCtx = {
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      actor,
      integrationId: INTEGRATION,
      authKey: "primary",
    };
    initSystemIntegrations([
      {
        id: INTEGRATION,
        clients: [
          {
            id: SYSTEM_CLIENT,
            auth_key: "primary",
            client_id: PUBLIC_CLIENT_ID,
            token_endpoint_auth_method: "none",
          },
        ],
      },
    ]);
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(upstream.base),
    });
  });

  afterEach(() => {
    upstream.stop();
    initSystemIntegrations([]);
  });

  async function storedRow(id: string) {
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1);
    return row!;
  }

  it("exchanges the submitted token as a public client and stores the rotated pair", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      refresh_token: "rt-rotated",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const conn = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "  rt-submitted  " },
    });

    // RFC 6749 §6 as a public client: client_id in the body, no Authorization header.
    expect(upstream.lastTokenRequest()).toEqual({
      form: {
        grant_type: "refresh_token",
        refresh_token: "rt-submitted",
        client_id: PUBLIC_CLIENT_ID,
      },
      authorization: null,
    });
    expect(conn.account_id).toBe("pierre-trek");

    const row = await storedRow(conn.id);
    const creds = decryptCredentialsToStringMap(row.credentialsEncrypted);
    expect(creds.access_token).toBe("at-fresh");
    expect(creds.refresh_token).toBe("rt-rotated");
    expect(creds.token_type).toBe("Bearer");
    expect(row.clientRef).toBe(SYSTEM_CLIENT);
    expect(row.needsReconnection).toBe(false);
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("keeps the submitted token when the server does not rotate it", async () => {
    upstream.setToken({ access_token: "at-fresh", expires_in: 3600 });

    const conn = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });

    const creds = decryptCredentialsToStringMap((await storedRow(conn.id)).credentialsEncrypted);
    expect(creds.refresh_token).toBe("rt-submitted");
  });

  it("refuses a token the server rejects, before anything is stored", async () => {
    upstream.setToken({ error: "invalid_grant" }, 400);

    const err = await strategy
      .complete(connectCtx, { kind: "fields", credentials: { refresh_token: "rt-dead" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("login_rejected");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reports a rejected OAuth client as a 502, before anything is stored", async () => {
    upstream.setToken({ error: "invalid_client" }, 401);

    const err = await strategy
      .complete(connectCtx, { kind: "fields", credentials: { refresh_token: "rt-submitted" } })
      .catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("oauth_client_rejected");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("says the token was spent when storing fails after a successful exchange", async () => {
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-rotated", expires_in: 3600 });
    // A reconnect target that is gone by the time the connection is written.
    const err = await strategy
      .complete(
        {
          ...connectCtx,
          target: {
            id: "00000000-0000-4000-8000-000000000000",
            spaceId: ctx.defaultSpaceId,
            scopesGranted: [],
          } as unknown as NonNullable<ConnectContext["target"]>,
        },
        { kind: "fields", credentials: { refresh_token: "rt-submitted" } },
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("already exchanged");
    expect(upstream.tokenRequests()).toBe(1);
  });

  it("refuses a submission that does not match credentials.schema without calling the server", async () => {
    const err = await strategy
      .complete(connectCtx, { kind: "fields", credentials: { token: "rt" } })
      .catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(400);
    expect(upstream.tokenRequests()).toBe(0);
  });

  it("refuses to begin an authorization flow", async () => {
    const err = await strategy.begin(connectCtx, {}).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(400);
  });
});
