// SPDX-License-Identifier: Apache-2.0

/**
 * An oauth2 auth acquiring its first token by `connect.login` (AFPS §7.7): `OAuth2Strategy.complete`
 * takes the submitted `fields`, renders the login's grant from them, posts it to the token endpoint
 * with the auth's default client — the token request every later refresh sends — and persists an
 * ordinary oauth2 connection, or refuses before anything is stored.
 *
 * A Bun.serve stands in for the token endpoint and the userinfo endpoint; a public system client
 * (`token_endpoint_auth_method: "none"`) serves the auth, as for a mobile-app SSO, and a
 * confidential one (`client_secret_basic`) checks the other client authentication.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import type { Actor } from "@appstrate/connect";
import { integrationManifestSchema } from "@appstrate/core/integration";
import { integrationConnections } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { initSystemIntegrations } from "../../../src/services/integration-client-registry.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";

const INTEGRATION = "@orga/oauth2-login";
/** The same auth served by a confidential client. */
const CONFIDENTIAL = "@orga/oauth2-login-basic";
/** A login posting somewhere other than its token endpoint. */
const MISDIRECTED = "@orga/oauth2-login-elsewhere";
const SYSTEM_CLIENT = "oauth2-login-sys";
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

function manifest(
  base: string,
  { name = INTEGRATION, auth = {}, loginUrl = `${base}/token` } = {} as {
    name?: string;
    auth?: Record<string, unknown>;
    loginUrl?: string;
  },
): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    type: "integration",
    schema_version: "0.1",
    source: { kind: "none" },
    auths: {
      primary: {
        type: "oauth2",
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
        connect: {
          login: {
            request: {
              method: "POST",
              url: loginUrl,
              content_type: "application/x-www-form-urlencoded",
              body: "grant_type=refresh_token&refresh_token={{refresh_token}}",
            },
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
        ...auth,
      },
    },
  };
}

describe("OAuth2Strategy — connect.login acquisition", () => {
  let ctx: TestContext;
  let actor: Actor;
  let connectCtx: ConnectContext;
  let upstream: Upstream;
  const strategy = new OAuth2Strategy();

  async function seed(draftManifest: Record<string, unknown>) {
    await seedPackage({
      id: draftManifest.name as string,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest,
    });
  }

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
    const publicClient = {
      id: SYSTEM_CLIENT,
      auth_key: "primary",
      client_id: PUBLIC_CLIENT_ID,
      token_endpoint_auth_method: "none",
    } as const;
    initSystemIntegrations([
      { id: INTEGRATION, clients: [publicClient] },
      { id: MISDIRECTED, clients: [{ ...publicClient, id: "oauth2-login-elsewhere-sys" }] },
      {
        id: CONFIDENTIAL,
        clients: [
          {
            id: "oauth2-login-basic-sys",
            auth_key: "primary",
            client_id: "confidential-id",
            client_secret: "confidential-secret",
            token_endpoint_auth_method: "client_secret_basic",
          },
        ],
      },
    ]);
    await seed(manifest(upstream.base));
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

  const submit = (credentials: Record<string, unknown>, connect: ConnectContext = connectCtx) =>
    strategy.complete(connect, { kind: "fields", credentials }).catch((e: unknown) => e);

  it("posts the rendered grant as a public client and stores the rotated pair", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      refresh_token: "rt-rotated",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const conn = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });

    // A public client: client_id in the body, no Authorization header.
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

  it("authenticates a confidential client with Basic, no client parameter in the body", async () => {
    await seed(
      manifest(upstream.base, {
        name: CONFIDENTIAL,
        auth: { token_endpoint_auth_method: "client_secret_basic" },
      }),
    );
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-rotated", expires_in: 3600 });

    await strategy.complete(
      { ...connectCtx, integrationId: CONFIDENTIAL },
      { kind: "fields", credentials: { refresh_token: "rt-submitted" } },
    );

    expect(upstream.lastTokenRequest()).toEqual({
      form: { grant_type: "refresh_token", refresh_token: "rt-submitted" },
      authorization: `Basic ${btoa("confidential-id:confidential-secret")}`,
    });
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

  it("refuses a grant the server rejects, before anything is stored", async () => {
    upstream.setToken({ error: "invalid_grant" }, 400);

    const err = await submit({ refresh_token: "rt-dead" });

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("login_rejected");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reports a rejected OAuth client as a 502, before anything is stored", async () => {
    upstream.setToken({ error: "invalid_client" }, 401);

    const err = await submit({ refresh_token: "rt-submitted" });

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("oauth_client_rejected");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("says the grant was redeemed when storing fails after a successful token request", async () => {
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-rotated", expires_in: 3600 });
    // A reconnect target that is gone by the time the connection is written.
    const err = await submit(
      { refresh_token: "rt-submitted" },
      {
        ...connectCtx,
        target: {
          id: "00000000-0000-4000-8000-000000000000",
          spaceId: ctx.defaultSpaceId,
          scopesGranted: [],
        } as unknown as NonNullable<ConnectContext["target"]>,
      },
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("already redeemed");
    expect(upstream.tokenRequests()).toBe(1);
  });

  it("refuses a submission that does not match credentials.schema without calling the server", async () => {
    const err = await submit({ token: "rt" });

    expect((err as ApiError).status).toBe(400);
    expect(upstream.tokenRequests()).toBe(0);
  });

  it("refuses to begin an authorization flow", async () => {
    const err = await strategy.begin(connectCtx, {}).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(400);
  });

  it("never posts a grant to a url other than token_endpoint", async () => {
    const other = manifest(upstream.base, {
      name: MISDIRECTED,
      loginUrl: `${upstream.base}/elsewhere`,
    });
    // The manifest gate refuses it (AFPS §7.7)…
    expect(
      integrationManifestSchema.safeParse(other).error?.issues.map((i) => i.path.join(".")),
    ).toEqual(["auths.primary.connect.login.request.url"]);
    // …and one stored past it never reaches the token endpoint: connecting re-reads it through
    // the same gate.
    await seed(other);

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: MISDIRECTED },
    );

    expect(err).toBeInstanceOf(Error);
    expect(upstream.tokenRequests()).toBe(0);
  });

  it("still asks a custom connect.login for outputs", () => {
    const custom = manifest(upstream.base, {
      auth: {
        type: "custom",
        token_endpoint: undefined,
        token_endpoint_auth_method: undefined,
        userinfo_endpoint: undefined,
        delivery: { env: { TOKEN: { value: "{$credential.token}" } } },
      },
    });
    expect(
      integrationManifestSchema.safeParse(custom).error?.issues.map((i) => i.path.join(".")),
    ).toContain("auths.primary.connect.login.outputs");
  });
});
