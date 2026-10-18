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
const SYSTEM_CLIENT = "oauth2-login-sys";
const PUBLIC_CLIENT_ID = "PUBLIC_MOBILE_CLIENT";

interface Upstream {
  base: string;
  /** Next token-endpoint answer; a string body is sent as is. */
  setToken: (body: Record<string, unknown> | string, status?: number) => void;
  /** The last token request: its form body and Authorization header. */
  lastTokenRequest: () => { form: Record<string, string>; authorization: string | null } | null;
  tokenRequests: () => number;
  stop: () => void;
}

function startUpstream(): Upstream {
  let tokenBody: Record<string, unknown> | string = {};
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
      { id: BLOCKED, clients: [{ ...publicClient, id: "oauth2-login-blocked-sys" }] },
      { id: REQUIRES_EMAIL, clients: [{ ...publicClient, id: "oauth2-login-email-sys" }] },
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

  it("says the grant may be redeemed when storing fails after a successful token request", async () => {
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
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).code).toBe("not_found");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect(upstream.tokenRequests()).toBe(1);
  });

  it("refuses a missing required identity claim after the token request, saying the grant may be redeemed", async () => {
    await seed(
      manifest(upstream.base, {
        name: REQUIRES_EMAIL,
        auth: { required_identity_claims: ["email"] },
      }),
    );
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-rotated", expires_in: 3600 });

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: REQUIRES_EMAIL },
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("invalid_request");
    expect((err as ApiError).message).toContain("'email'");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect(upstream.tokenRequests()).toBe(1);
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reconnects in place: same row, credentials replaced, client re-pinned", async () => {
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-1", expires_in: 3600 });
    const first = await strategy.complete(connectCtx, {
      kind: "fields",
      credentials: { refresh_token: "rt-submitted" },
    });
    // A pin gone stale since (a client remapped): the reconnect writes the current one back.
    await db
      .update(integrationConnections)
      .set({ clientRef: "stale-client" })
      .where(eq(integrationConnections.id, first.id));
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-2", expires_in: 3600 });

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
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-1", expires_in: 3600 });
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
      expect(await db.select().from(integrationConnections)).toHaveLength(0);
    });
  }

  it("reports a token request the egress guard refuses as a 502 with the grant intact", async () => {
    // Nothing listens there: only the guard's refusal, never a connection error, omits the note.
    await seed(manifest("http://127.0.0.2:9", { name: BLOCKED }));

    const err = await submit(
      { refresh_token: "rt-submitted" },
      { ...connectCtx, integrationId: BLOCKED },
    );

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).not.toContain("redeemed");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reports a 2xx without access_token as a 502 that may have redeemed the grant", async () => {
    upstream.setToken({ token_type: "Bearer" });

    const err = await submit({ refresh_token: "rt-submitted" });

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("reports a failing token endpoint as a 502 that may have redeemed the grant", async () => {
    upstream.setToken({ error: "server_error" }, 503);

    const err = await submit({ refresh_token: "rt-submitted" });

    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("login_upstream_unavailable");
    expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
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
    upstream.setToken({ access_token: "at-fresh", refresh_token: "rt-rotated", expires_in: 3600 });
    const fault = new Error("database unavailable");
    const save = spyOn(connections, "saveIntegrationConnection").mockRejectedValueOnce(fault);
    try {
      const err = await submit({ refresh_token: "rt-submitted" });

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).code).toBe("internal_error");
      expect((err as ApiError).message).toContain("may have redeemed the submitted grant");
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
});
