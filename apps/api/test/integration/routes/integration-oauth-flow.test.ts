// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end OAuth2 connect flow, driven through the platform's own routes
 * against a CONFORMANT authorization server (`helpers/strict-authorization-server`).
 *
 * Until this suite existed, no test walked the nominal path at all: the
 * callback tests cover only its failure branches (missing params, `?error=`,
 * forged state, XSS in `?error`), and the one mock IdP in the repo answered
 * `200` with a token for any request. A token exchange that sent a malformed
 * client credential therefore passed every test in CI and failed at a
 * customer's consent screen — which is how `@appstrate/dropbox` shipped
 * unconnectable.
 *
 * Each case here runs: register client → POST /connect/oauth2 → follow the
 * authorize URL as a browser would → GET /callback with the returned code →
 * assert the persisted connection (or the refusal) → refresh it. The provider
 * refuses non-conformant requests with the RFC's own error codes, so what is
 * asserted is the platform's wire behaviour, not a mock's recorded bytes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { apiIntegrationManifest, httpHeaderDelivery } from "../../helpers/integration-manifests.ts";
import {
  createStrictAuthorizationServer,
  allowLoopbackOAuthEgress,
  type StrictAuthorizationServer,
  type StrictAuthorizationServerOptions,
} from "../../helpers/strict-authorization-server.ts";
import { applicationPackages, integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import {
  buildIntegrationOAuthRefreshContext,
  forceRefreshIntegrationConnection,
} from "../../../src/services/integration-token-refresh.ts";
import { readIntegrationAuth } from "../../../src/services/integration-connections.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

const app = getTestApp();
const INTEGRATION = "@myorg/probe";
const AUTH_KEY = "primary";
const SCOPES = ["files.read"];

let restoreEgress: () => void;

beforeAll(() => {
  // Loopback egress is fail-closed for secret-bearing OAuth requests; the
  // operator opt-in is the supported way to reach an IdP on a private address.
  restoreEgress = allowLoopbackOAuthEgress();
});

afterAll(() => restoreEgress());

/**
 * Install the probe integration whose manifest points at `provider`, and
 * register the OAuth client the admin would have registered.
 */
async function setup(
  ctx: TestContext,
  provider: StrictAuthorizationServer,
  manifest: {
    tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
    authorizationParams?: Record<string, string>;
    refreshTokenIssuance?: "default" | "not_supported";
  },
  client: { clientId: string; clientSecret: string },
): Promise<void> {
  await seedPackage({
    id: INTEGRATION,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: apiIntegrationManifest({
      name: INTEGRATION,
      auths: {
        [AUTH_KEY]: {
          type: "oauth2",
          authorizationEndpoint: provider.authorizationEndpoint,
          tokenEndpoint: provider.tokenEndpoint,
          defaultScopes: SCOPES,
          tokenEndpointAuthMethod: manifest.tokenEndpointAuthMethod,
          codeChallengeMethodsSupported: ["S256"],
          ...(manifest.authorizationParams
            ? { authorizationParams: manifest.authorizationParams }
            : {}),
          ...(manifest.refreshTokenIssuance
            ? { refreshTokenIssuance: manifest.refreshTokenIssuance }
            : {}),
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "access_token",
          }),
        },
      },
    }),
  });
  await db
    .insert(applicationPackages)
    .values({ applicationId: ctx.defaultAppId, packageId: INTEGRATION, config: {} });

  // A secret-less registration must DECLARE itself public: the route refuses a
  // missing/blank `client_secret` under any other method rather than inferring
  // "public" from the absence, which is what the admin form's checkbox sends.
  const res = await app.request(
    `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/oauth-clients`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        client.clientSecret === ""
          ? { client_id: client.clientId, token_endpoint_auth_method: "none" }
          : { client_id: client.clientId, client_secret: client.clientSecret },
      ),
    },
  );
  expect(res.status).toBeLessThan(300);
}

/** Kick the OAuth flow off and return the authorize URL the SPA would open. */
async function beginConnect(ctx: TestContext): Promise<string> {
  const res = await app.request(
    `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/connect/oauth2`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { auth_url: string };
  return body.auth_url;
}

/**
 * Play the consent step the way a browser does: GET the authorize URL, read
 * the 302 the provider answers, and hand its `code`/`state` to the platform's
 * public callback. Returns the callback's HTML.
 */
async function consentAndCallback(authUrl: string): Promise<string> {
  // Plain fetch — this hop is the user's browser talking to the IdP, not
  // platform egress.
  const consent = await fetch(authUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get("Location")!);
  const code = location.searchParams.get("code");
  const state = location.searchParams.get("state");
  expect(code).toBeTruthy();
  expect(state).toBeTruthy();
  const res = await app.request(
    `/api/integrations/callback?code=${encodeURIComponent(code!)}&state=${encodeURIComponent(state!)}`,
  );
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * Refresh the connection the way the live resolvers do: resolve the pinned
 * minting client from the DB, build the refresh context off the manifest, then
 * POST the `refresh_token` grant. Exercises the same client/auth-method
 * resolution the initial exchange used.
 */
async function refresh(ctx: TestContext, connectionId: string): Promise<void> {
  const row = (
    await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1)
  )[0]!;
  const { auth } = await readIntegrationAuth(
    { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    INTEGRATION,
    AUTH_KEY,
  );
  const context = await buildIntegrationOAuthRefreshContext(
    INTEGRATION,
    AUTH_KEY,
    auth as AfpsManifestAuth,
    ctx.defaultAppId,
    row.clientRef,
  );
  expect(context).not.toBeNull();
  await forceRefreshIntegrationConnection(
    connectionId,
    INTEGRATION,
    AUTH_KEY,
    row.credentialsEncrypted,
    context!,
  );
}

/** The single connection row, or null. */
async function storedConnection() {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.integrationId, INTEGRATION));
  return rows[0] ?? null;
}

describe("integration OAuth2 flow (conformant provider)", () => {
  let ctx: TestContext;
  let provider: StrictAuthorizationServer;

  const startProvider = (options: StrictAuthorizationServerOptions): StrictAuthorizationServer => {
    provider = createStrictAuthorizationServer(options);
    return provider;
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  afterEach(() => provider?.stop());

  // ─── The nominal path, per client-authentication method ────────────────

  it("connects and refreshes with client_secret_post", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
      // Inside `OAUTH_REFRESH_LEAD_MS` (5 min) on arrival, so the refresh path
      // runs its real proactive-renewal predicate rather than being handed a
      // backdated `expires_at`.
      expiresIn: 60,
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "shh" },
    );
    await consentAndCallback(await beginConnect(ctx));

    const connection = await storedConnection();
    expect(connection).not.toBeNull();
    const credentials = decryptCredentialsToStringMap(connection!.credentialsEncrypted);
    expect(credentials.access_token).toBe(provider.issuedAccessTokens[0]);
    expect(credentials.refresh_token).toBe(provider.issuedRefreshTokens[0]);
    // The provider accepted the exchange — no `invalid_client` anywhere.
    expect(provider.tokenRequests.every((r) => r.status === 200)).toBe(true);

    await refresh(ctx, connection!.id);
    // The provider minted a second access token off the `refresh_token` grant,
    // and the platform persisted it.
    expect(provider.tokenRequests.map((r) => r.grantType)).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(provider.issuedAccessTokens).toHaveLength(2);
    const refreshed = await storedConnection();
    expect(decryptCredentialsToStringMap(refreshed!.credentialsEncrypted).access_token).toBe(
      provider.issuedAccessTokens[1]!,
    );
  });

  it("connects with client_secret_basic", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_basic"],
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_basic" },
      { clientId: "cid", clientSecret: "shh" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(await storedConnection()).not.toBeNull();
    expect(provider.tokenRequests[0]!.authorization).toMatch(/^Basic /);
    expect(provider.tokenRequests[0]!.params.client_secret).toBeUndefined();
  });

  it("connects with a manifest-declared public client (none)", async () => {
    startProvider({ clientId: "cid", acceptedAuthMethods: ["none"] });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "none" },
      { clientId: "cid", clientSecret: "", tokenEndpointAuthMethod: "none" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(await storedConnection()).not.toBeNull();
    expect(provider.tokenRequests[0]!.params.client_id).toBe("cid");
    expect(provider.tokenRequests[0]!.params.client_secret).toBeUndefined();
  });

  // ─── The defect that shipped ───────────────────────────────────────────

  // The admin registers the app as PUBLIC (the UI's "public client" checkbox)
  // while the manifest still declares `client_secret_post`. Before the fix the
  // exchange posted `client_secret=` and this provider — like Dropbox —
  // answered `invalid_client`, leaving no connection behind.
  it("a public registered client connects even when the manifest declares client_secret_post", async () => {
    startProvider({ clientId: "cid", acceptedAuthMethods: ["none"] });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "", tokenEndpointAuthMethod: "none" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(await storedConnection()).not.toBeNull();
    const request = provider.tokenRequests[0]!;
    expect(request.status).toBe(200);
    expect(request.error).toBeUndefined();
    // The empty secret must be ABSENT, not present-and-empty.
    expect(request.params.client_secret).toBeUndefined();
    expect(request.authorization).toBeUndefined();
  });

  it("a public registered client sends no empty Basic header either", async () => {
    startProvider({ clientId: "cid", acceptedAuthMethods: ["none"] });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_basic" },
      { clientId: "cid", clientSecret: "", tokenEndpointAuthMethod: "none" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(await storedConnection()).not.toBeNull();
    expect(provider.tokenRequests[0]!.authorization).toBeUndefined();
    expect(provider.tokenRequests[0]!.status).toBe(200);
  });

  // ─── Offline access: the second half of the same incident ──────────────

  // A provider that gates refresh tokens on an authorize-time flag (Google
  // `access_type=offline`, Dropbox `token_access_type=offline`, Reddit
  // `duration=permanent`) returns a short-lived token and NO refresh token
  // when the manifest omits it. The platform must refuse rather than persist a
  // connection that dies at expiry.
  it("refuses a connection when the manifest omits the provider's offline flag", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
      offlineParam: { name: "token_access_type", value: "offline" },
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "shh" },
    );
    const html = await consentAndCallback(await beginConnect(ctx));

    // The exchange itself succeeded — the provider simply issued no refresh
    // token — so this is the platform's own guard, not a provider error.
    expect(provider.tokenRequests[0]!.status).toBe(200);
    expect(provider.issuedRefreshTokens).toHaveLength(0);
    expect(await storedConnection()).toBeNull();
    expect(html).toContain("window.close");
  });

  it("connects when the manifest declares the provider's offline flag", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
      offlineParam: { name: "token_access_type", value: "offline" },
    });
    await setup(
      ctx,
      provider,
      {
        tokenEndpointAuthMethod: "client_secret_post",
        authorizationParams: { token_access_type: "offline" },
      },
      { clientId: "cid", clientSecret: "shh" },
    );
    // The flag must actually reach the authorize URL.
    const authUrl = await beginConnect(ctx);
    expect(new URL(authUrl).searchParams.get("token_access_type")).toBe("offline");

    await consentAndCallback(authUrl);
    const connection = await storedConnection();
    expect(connection).not.toBeNull();
    expect(decryptCredentialsToStringMap(connection!.credentialsEncrypted).refresh_token).toBe(
      provider.issuedRefreshTokens[0],
    );
  });

  // A provider that issues access-only tokens BY DESIGN (many remote MCP
  // servers) is not a misconfiguration. Before this, the manifest could say so
  // and be ignored: the conformance gate accepted the declaration while this
  // path still refused the connection, so a manifest passed CI and failed at a
  // user's consent screen.
  it("persists an access-only connection when the manifest declares refresh_token_issuance=not_supported", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
      // Gated on a flag the manifest deliberately does not send → no refresh token.
      offlineParam: { name: "token_access_type", value: "offline" },
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post", refreshTokenIssuance: "not_supported" },
      { clientId: "cid", clientSecret: "shh" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(provider.issuedRefreshTokens).toHaveLength(0);
    const connection = await storedConnection();
    // Persisted, not refused — it re-authorises at expiry, by design.
    expect(connection).not.toBeNull();
    expect(decryptCredentialsToStringMap(connection!.credentialsEncrypted).refresh_token).toBe(
      undefined,
    );
  });

  // The declaration is authoritative only for "not_supported". A manifest that
  // says nothing still gets the strict refusal, which is what caught
  // @appstrate/dropbox.
  it("still refuses when the manifest declares nothing", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
      offlineParam: { name: "token_access_type", value: "offline" },
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "shh" },
    );
    await consentAndCallback(await beginConnect(ctx));
    expect(await storedConnection()).toBeNull();
  });

  // ─── Protocol discipline the provider enforces for us ──────────────────

  it("sends a PKCE challenge the provider can verify", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "shh" },
    );
    await consentAndCallback(await beginConnect(ctx));

    expect(provider.authorizeRequests[0]!.params.code_challenge_method).toBe("S256");
    expect(provider.tokenRequests[0]!.params.code_verifier).toBeTruthy();
    // A verifier that did not match would have been refused by the provider.
    expect(provider.tokenRequests[0]!.status).toBe(200);
    expect(await storedConnection()).not.toBeNull();
  });

  it("never redeems the same authorization code twice", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "shh",
      acceptedAuthMethods: ["client_secret_post"],
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "shh" },
    );
    const authUrl = await beginConnect(ctx);
    const consent = await fetch(authUrl, { redirect: "manual" });
    const location = new URL(consent.headers.get("Location")!);
    const code = location.searchParams.get("code")!;
    const state = location.searchParams.get("state")!;
    const callback = `/api/integrations/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

    expect((await app.request(callback)).status).toBe(200);
    expect(await storedConnection()).not.toBeNull();

    // Replay: the state is consume-once, so the platform must not even reach
    // the provider a second time.
    const before = provider.tokenRequests.length;
    const replay = await app.request(callback);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toMatch(/Could not complete the connection|try again/i);
    expect(provider.tokenRequests.length).toBe(before);
  });

  it("surfaces the provider's error code when client credentials are wrong", async () => {
    startProvider({
      clientId: "cid",
      clientSecret: "the-real-secret",
      acceptedAuthMethods: ["client_secret_post"],
    });
    await setup(
      ctx,
      provider,
      { tokenEndpointAuthMethod: "client_secret_post" },
      { clientId: "cid", clientSecret: "the-wrong-secret" },
    );
    const html = await consentAndCallback(await beginConnect(ctx));

    expect(provider.tokenRequests[0]!.error).toBe("invalid_client");
    expect(await storedConnection()).toBeNull();
    // The callback page names the machine-readable code so an operator can act
    // on it — a generic sentence alone is what sent the last one to support.
    expect(html).toContain("invalid_client");
  });
});
