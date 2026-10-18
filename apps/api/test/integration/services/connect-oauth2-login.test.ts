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

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import type { Actor } from "@appstrate/connect";
import { integrationManifestSchema } from "@appstrate/core/integration";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { initSystemIntegrations } from "../../../src/services/integration-client-registry.ts";
import * as connections from "../../../src/services/integration-connections.ts";
import {
  createIntegrationOAuthClient,
  readCredentialRevision,
} from "../../../src/services/integration-connections.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import { refreshConnectionCredential } from "../../../src/services/integration-token-refresh.ts";
import { OAuth2Strategy } from "../../../src/services/connect/oauth2-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";

const INTEGRATION = "@orga/oauth2-login";
/** The same auth served by a confidential client. */
const CONFIDENTIAL = "@orga/oauth2-login-basic";
/** A login posting somewhere other than its token endpoint. */
const MISDIRECTED = "@orga/oauth2-login-elsewhere";
/** The auth served by an organization client, with no system client. */
const ORG_CLIENT = "@orga/oauth2-login-org";
/** A token endpoint the egress guard refuses: a loopback address outside the test allowlist. */
const BLOCKED = "@orga/oauth2-login-blocked";
/** The auth requiring an identity claim the userinfo answer lacks. */
const REQUIRES_EMAIL = "@orga/oauth2-login-email";
/** The auth declaring an `issuer`, whose metadata binds its client to a token endpoint. */
const ISSUER_BOUND = "@orga/oauth2-login-issuer";
/** The auth whose client authenticates with a method the token request does not implement. */
const JWT_CLIENT = "@orga/oauth2-login-jwt";
/** The auth whose grant names its refresh token from a field called `token`, and asks a scope. */
const RENAMED_FIELD = "@orga/oauth2-login-renamed";
const SYSTEM_CLIENT = "oauth2-login-sys";
const PUBLIC_CLIENT_ID = "PUBLIC_MOBILE_CLIENT";

interface Upstream {
  base: string;
  /** Next token-endpoint answer; a string body is sent as is. */
  setToken: (body: Record<string, unknown> | string, status?: number) => void;
  /** The last token request: its form body and Authorization header. */
  lastTokenRequest: () => { form: Record<string, string>; authorization: string | null } | null;
  tokenRequests: () => number;
  /** The authorization server metadata (RFC 8414) served for the issuer `base`; `null` serves none. */
  setMetadata: (doc: Record<string, unknown> | null) => void;
  stop: () => void;
}

function startUpstream(): Upstream {
  let tokenBody: Record<string, unknown> | string = {};
  let tokenStatus = 200;
  let last: { form: Record<string, string>; authorization: string | null } | null = null;
  let served = 0;
  let metadata: Record<string, unknown> | null = null;
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
        return typeof tokenBody === "string"
          ? new Response(tokenBody, { status: tokenStatus })
          : Response.json(tokenBody, { status: tokenStatus });
      }
      if (url.pathname === "/userinfo") {
        if (req.headers.get("authorization") !== "Bearer at-fresh") {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ profileId: 4242, displayName: "pierre-trek" });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server" && metadata) {
        return Response.json(metadata);
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
    setMetadata: (doc) => {
      metadata = doc;
    },
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
      { id: BLOCKED, clients: [{ ...publicClient, id: "oauth2-login-blocked-sys" }] },
      { id: REQUIRES_EMAIL, clients: [{ ...publicClient, id: "oauth2-login-email-sys" }] },
      { id: ISSUER_BOUND, clients: [{ ...publicClient, id: "oauth2-login-issuer-sys" }] },
      { id: RENAMED_FIELD, clients: [{ ...publicClient, id: "oauth2-login-renamed-sys" }] },
      {
        id: JWT_CLIENT,
        // No method of its own: the manifest's stands in.
        clients: [
          {
            id: "oauth2-login-jwt-sys",
            auth_key: "primary",
            client_id: "jwt-id",
            client_secret: "jwt-secret",
          },
        ],
      },
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
    // Identity from the userinfo body: the token response carries none.
    expect(conn.account_id).toBe("pierre-trek");
    expect(conn.identity_claims).toEqual({ account_id: "pierre-trek", profile_id: 4242 });

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
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });

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
    upstream.setToken({ access_token: "at-fresh", token_type: "Bearer", expires_in: 3600 });

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

  it("says the grant may be redeemed when storing fails after a successful token request", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });
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
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
    expect(upstream.tokenRequests()).toBe(1);
  });

  it("refuses a missing required identity claim after the token request, saying the grant may be redeemed", async () => {
    await seed(
      manifest(upstream.base, {
        name: REQUIRES_EMAIL,
        auth: { required_identity_claims: ["email"] },
      }),
    );
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: REQUIRES_EMAIL },
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("invalid_request");
    expect((err as ApiError).message).toContain("'email'");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
    expect(upstream.tokenRequests()).toBe(1);
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reconnects in place: same row, credentials replaced, client re-pinned", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-1",
      expires_in: 3600,
    });
    const first = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });
    // A pin gone stale since (a client remapped): the reconnect writes the current one back.
    await db
      .update(integrationConnections)
      .set({ clientRef: "stale-client" })
      .where(eq(integrationConnections.id, first.id));
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-2",
      expires_in: 3600,
    });

    const again = await strategy.complete(
      {
        ...connectCtx,
        target: { id: first.id, spaceId: ctx.defaultSpaceId, scopesGranted: [] },
      },
      { kind: "fields", credentials: { refresh_token: "rt-resubmitted" } },
    );

    expect(again.id).toBe(first.id);
    expect(await db.select().from(integrationConnections)).toHaveLength(1);
    expect(upstream.lastTokenRequest()!.form.refresh_token).toBe("rt-resubmitted");
    const row = await storedRow(first.id);
    expect(decryptCredentialsToStringMap(row.credentialsEncrypted).refresh_token).toBe("rt-2");
    expect(row.clientRef).toBe(SYSTEM_CLIENT);
  });

  it("is refreshed later with the same client, and the rotation is written back", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-1",
      expires_in: 3600,
    });
    const conn = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });
    const row = await storedRow(conn.id);
    upstream.setToken({ access_token: "at-refreshed", refresh_token: "rt-2", expires_in: 3600 });

    const outcome = await refreshConnectionCredential({
      connection: {
        id: row.id,
        authKey: "primary",
        credentialsEncrypted: row.credentialsEncrypted,
        clientRef: row.clientRef,
        oauthResource: row.oauthResource,
        expiresAt: row.expiresAt,
        credentialRevision: (await readCredentialRevision(row.id))!,
      },
      integrationId: INTEGRATION,
      authDef: (manifest(upstream.base).auths as Record<string, AfpsManifestAuth>).primary!,
      scope: connectCtx.scope,
      actor,
      trigger: { kind: "rejected", revision: null },
    });

    expect(outcome.status).toBe("refreshed");
    expect(upstream.lastTokenRequest()).toEqual({
      form: { grant_type: "refresh_token", refresh_token: "rt-1", client_id: PUBLIC_CLIENT_ID },
      authorization: null,
    });
    const creds = decryptCredentialsToStringMap((await storedRow(conn.id)).credentialsEncrypted);
    expect(creds.access_token).toBe("at-refreshed");
    expect(creds.refresh_token).toBe("rt-2");
  });

  for (const [label, body, status] of [
    ["an OAuth error other than invalid_grant", { error: "invalid_request" }, 400],
    ["a bare 401", "unauthorized", 401],
  ] as const) {
    it(`refuses the submitted grant on ${label}, before anything is stored`, async () => {
      upstream.setToken(body, status);

      const err = await submit({ refresh_token: "rt-submitted" });

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe("login_rejected");
      expect((err as ApiError).message).toContain(`HTTP ${status}`);
      expect(await db.select().from(integrationConnections)).toHaveLength(0);
    });
  }

  for (const [label, body, status] of [
    ["a throttled token endpoint", { error: "slow_down" }, 429],
    ["a bare 403 (a firewall refusing the client)", "forbidden", 403],
  ] as const) {
    it(`reports ${label} as a 502 with the grant intact`, async () => {
      upstream.setToken(body, status);

      const err = await submit({ refresh_token: "rt-submitted" });

      expect((err as ApiError).status).toBe(502);
      expect((err as ApiError).code).toBe("login_upstream_unavailable");
      expect((err as ApiError).retryAfter).toBeUndefined();
      expect((err as ApiError).message).not.toContain("redeemed");
      expect((err as ApiError).extensions?.grant_may_be_redeemed).toBeUndefined();
      expect(await db.select().from(integrationConnections)).toHaveLength(0);
    });
  }

  it("reports a token request the egress guard refuses as a 502 with the grant intact", async () => {
    // Nothing listens there: only the guard's refusal, never a connection error, omits the note.
    await seed(manifest("http://127.0.0.2:9", { name: BLOCKED }));

    let presented = false;
    const err = await submit(
      { refresh_token: "rt-submitted" },
      {
        ...connectCtx,
        integrationId: BLOCKED,
        onGrantPresented: () => {
          presented = true;
        },
      },
    );

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).not.toContain("redeemed");
    expect((err as ApiError).extensions?.grant_may_be_redeemed).toBeUndefined();
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
    // The guard refused a request it never sent: the grant was not presented.
    expect(presented).toBe(false);
  });

  it("reports a 2xx without access_token as a 502 that may have redeemed the grant", async () => {
    upstream.setToken({ token_type: "Bearer" });

    const err = await submit({ refresh_token: "rt-submitted" });

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reports a failing token endpoint as a 502 that may have redeemed the grant", async () => {
    upstream.setToken({ error: "server_error" }, 503);

    const err = await submit({ refresh_token: "rt-submitted" });

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("refuses an auth whose client secret cannot be decrypted as a 403, without calling the server", async () => {
    await seed(
      manifest(upstream.base, {
        name: ORG_CLIENT,
        auth: { token_endpoint_auth_method: "client_secret_post" },
      }),
    );
    const client = await createIntegrationOAuthClient({ orgId: ctx.orgId }, ORG_CLIENT, "primary", {
      clientId: "org-client",
      clientSecret: "org-secret",
    });
    // A ciphertext under the current key that no longer opens.
    const [stored] = await db
      .select({ secret: integrationOauthClients.clientSecretEncrypted })
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.id, client.id));
    await db
      .update(integrationOauthClients)
      .set({ clientSecretEncrypted: stored!.secret.replace(/:[^:]+$/, `:${"A".repeat(64)}`) })
      .where(eq(integrationOauthClients.id, client.id));

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: ORG_CLIENT },
    );

    expect((err as ApiError).status).toBe(403);
    expect(upstream.tokenRequests()).toBe(0);
  });

  it("is a 409 when the chosen client is gone by the token request, without calling the server", async () => {
    // Removed between the client choice and the token request.
    const gone = spyOn(connections, "resolveIntegrationClientById").mockResolvedValueOnce(null);
    try {
      const err = await submit({ refresh_token: "rt-submitted" });

      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe("connection_not_ready");
      expect(gone).toHaveBeenCalledTimes(1);
      expect(upstream.tokenRequests()).toBe(0);
    } finally {
      gone.mockRestore();
    }
  });

  it("wraps a storage fault after a successful token request as a 500 that says so", async () => {
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });
    const fault = new Error("database unavailable");
    const save = spyOn(connections, "saveIntegrationConnection").mockRejectedValueOnce(fault);
    try {
      const err = await submit({ refresh_token: "rt-submitted" });

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).code).toBe("internal_error");
      expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
      expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
      expect((err as ApiError).cause).toBe(fault);
    } finally {
      save.mockRestore();
    }
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

    // The read gate drops the invalid manifest, so the integration is not found.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe(
      `Integration '${MISDIRECTED}' not found in this organization`,
    );
    expect(upstream.tokenRequests()).toBe(0);
  });

  /** An unsigned JWT: the platform never verifies one on this path, so the signature is junk. */
  const unsignedJwt = (claims: Record<string, unknown>) =>
    [{ alg: "none", typ: "JWT" }, claims]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .concat("sig")
      .join(".");

  it("never reads identity from an id_token on this path", async () => {
    await seed(
      manifest(upstream.base, {
        name: REQUIRES_EMAIL,
        auth: { required_identity_claims: ["email"] },
      }),
    );
    upstream.setToken({
      access_token: "at-fresh",
      token_type: "Bearer",
      refresh_token: "rt-rotated",
      expires_in: 3600,
      id_token: unsignedJwt({ sub: "forged", email: "forged@example.com" }),
    });

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: REQUIRES_EMAIL },
    );

    // The claim is in the id_token only: unread, it is missing.
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toContain("'email'");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  for (const [label, tokenType] of [
    ["without token_type", undefined],
    ["of type N_A", "N_A"],
  ] as const) {
    it(`refuses a token ${label} after the request, saying the grant may be redeemed`, async () => {
      upstream.setToken({
        access_token: "at-fresh",
        refresh_token: "rt-rotated",
        expires_in: 3600,
        ...(tokenType ? { token_type: tokenType } : {}),
      });

      const err = await submit({ refresh_token: "rt-submitted" });

      expect((err as ApiError).status).toBe(502);
      expect((err as ApiError).code).toBe("login_upstream_unavailable");
      expect((err as ApiError).message).toContain("bearer");
      expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
      expect((err as ApiError).extensions?.grant_may_be_redeemed).toBe(true);
      expect(upstream.tokenRequests()).toBe(1);
      expect(await db.select().from(integrationConnections)).toHaveLength(0);
    });
  }

  it("accepts a bearer token_type in any case", async () => {
    upstream.setToken({ access_token: "at-fresh", token_type: "bearer", expires_in: 3600 });

    const conn = await submit({ refresh_token: "rt-submitted" });

    expect(conn).not.toBeInstanceOf(Error);
  });

  it("keeps the presented refresh token whatever the field it was typed in, and grants the requested scope", async () => {
    await seed(
      manifest(upstream.base, {
        name: RENAMED_FIELD,
        auth: {
          credentials: {
            schema: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
            },
          },
          connect: {
            login: {
              request: {
                method: "POST",
                url: `${upstream.base}/token`,
                content_type: "application/x-www-form-urlencoded",
                body: "grant_type=refresh_token&refresh_token={{token}}&scope=activity+profile",
              },
            },
          },
        },
      }),
    );
    // Neither rotated nor scoped: RFC 6749 §6 keeps the token, §5.1 grants the requested scope.
    upstream.setToken({ access_token: "at-fresh", token_type: "Bearer", expires_in: 3600 });

    const conn = await strategy.complete(
      { ...connectCtx, integrationId: RENAMED_FIELD },
      { kind: "fields", credentials: { token: "rt-submitted" } },
    );

    expect(upstream.lastTokenRequest()!.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-submitted",
      scope: "activity profile",
      client_id: PUBLIC_CLIENT_ID,
    });
    expect(conn.scopes_granted).toEqual(["activity", "profile"]);
    const creds = decryptCredentialsToStringMap((await storedRow(conn.id)).credentialsEncrypted);
    expect(creds.refresh_token).toBe("rt-submitted");
    expect(creds.scope).toBe("activity profile");
  });

  it("stores no scope when neither the request nor the response names one", async () => {
    upstream.setToken({ access_token: "at-fresh", token_type: "Bearer", expires_in: 3600 });

    const conn = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });

    expect(conn.scopes_granted).toEqual([]);
  });

  it("refuses a client authentication the token request does not implement, without calling the server", async () => {
    await seed(
      manifest(upstream.base, {
        name: JWT_CLIENT,
        auth: { token_endpoint_auth_method: "private_key_jwt" },
      }),
    );

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: JWT_CLIENT },
    );

    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("connection_not_ready");
    expect((err as ApiError).message).toContain("private_key_jwt");
    expect(upstream.tokenRequests()).toBe(0);
  });

  describe("an auth declaring an issuer", () => {
    const presented: boolean[] = [];
    const issuerCtx = () => ({
      ...connectCtx,
      integrationId: ISSUER_BOUND,
      onGrantPresented: () => presented.push(true),
    });

    beforeEach(async () => {
      presented.length = 0;
      await seed(manifest(upstream.base, { name: ISSUER_BOUND, auth: { issuer: upstream.base } }));
    });

    it("posts to the token endpoint its issuer's metadata names", async () => {
      upstream.setMetadata({ issuer: upstream.base, token_endpoint: `${upstream.base}/token` });
      upstream.setToken({ access_token: "at-fresh", token_type: "Bearer", expires_in: 3600 });

      const conn = await submit({ refresh_token: "rt-submitted" }, issuerCtx());

      expect(conn).not.toBeInstanceOf(Error);
      expect(upstream.tokenRequests()).toBe(1);
      expect(presented).toEqual([true]);
    });

    it("sends nothing to a token endpoint its issuer's metadata contradicts", async () => {
      upstream.setMetadata({ issuer: upstream.base, token_endpoint: `${upstream.base}/other` });

      const err = await submit({ refresh_token: "rt-submitted" }, issuerCtx());

      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe("invalid_request");
      expect((err as ApiError).message).toContain("token_endpoint");
      expect(upstream.tokenRequests()).toBe(0);
      expect(presented).toEqual([]);
    });

    it("sends nothing while its issuer's metadata cannot be read", async () => {
      upstream.setMetadata(null);

      const err = await submit({ refresh_token: "rt-submitted" }, issuerCtx());

      expect((err as ApiError).status).toBe(502);
      expect((err as ApiError).code).toBe("login_upstream_unavailable");
      expect((err as ApiError).extensions?.grant_may_be_redeemed).toBeUndefined();
      expect(upstream.tokenRequests()).toBe(0);
      expect(presented).toEqual([]);
    });
  });
});
