// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile } from "../../helpers/seed.ts";
import { createMockOAuthServer, type MockOAuthServer } from "../../helpers/oauth-server.ts";
import { applicationProviderCredentials, userProviderConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { encryptCredentials, decryptCredentials, OAuthCallbackError } from "@appstrate/connect";
import {
  initiateConnection,
  handleCallback,
} from "../../../src/services/connection-manager/oauth.ts";
import { oauthStateStore } from "../../../src/services/connection-manager/oauth-state-store.ts";
import type { Actor } from "../../../src/lib/actor.ts";

// ─── Mock OAuth Server ───────────────────────────────────────

// Start once for the entire test file — each test resets state via truncateAll + clearRequests
const mockServer: MockOAuthServer = createMockOAuthServer();

afterAll(() => {
  mockServer.stop();
});

// ─── Helpers ─────────────────────────────────────────────────

/** Seed a provider package with OAuth2 definition pointing at the mock server. */
async function seedOAuth2Provider(
  orgId: string | null,
  providerId: string,
  overrides: {
    pkceEnabled?: boolean;
    defaultScopes?: string[];
    scopeSeparator?: string;
    tokenAuthMethod?: string;
    authorizationParams?: Record<string, string>;
    tokenParams?: Record<string, string>;
  } = {},
) {
  return seedPackage({
    id: providerId,
    orgId: orgId as string,
    type: "provider",
    draftManifest: {
      name: providerId,
      version: "0.1.0",
      type: "provider",
      description: "Test OAuth2 provider",
      displayName: "Test Provider",
      definition: {
        authMode: "oauth2",
        oauth2: {
          authorizationUrl: `${mockServer.url}/authorize`,
          tokenUrl: `${mockServer.url}/token`,
          defaultScopes: overrides.defaultScopes ?? ["read", "write"],
          scopeSeparator: overrides.scopeSeparator ?? " ",
          pkceEnabled: overrides.pkceEnabled ?? true,
          tokenAuthMethod: overrides.tokenAuthMethod,
          authorizationParams: overrides.authorizationParams ?? {},
          tokenParams: overrides.tokenParams ?? {},
        },
      },
    },
    draftContent: "",
  });
}

/** Seed admin OAuth credentials (clientId/clientSecret) for a provider in an application. */
async function seedProviderCredentialsForApp(
  providerId: string,
  applicationId: string,
  creds: { clientId: string; clientSecret: string },
) {
  const encrypted = encryptCredentials(creds);
  await db.insert(applicationProviderCredentials).values({
    applicationId,
    providerId,
    credentialsEncrypted: encrypted,
    enabled: true,
  });
}

// ─── Tests ───────────────────────────────────────────────────

describe("OAuth2 flows", () => {
  let userId: string;
  let orgId: string;
  let appId: string;
  let profileId: string;
  let actor: Actor;

  const PROVIDER_ID = "@testorg/test-oauth-provider";
  const CLIENT_ID = "test-client-id-12345";
  const CLIENT_SECRET = "test-client-secret-67890";
  beforeEach(async () => {
    await truncateAll();
    mockServer.clearRequests();
    mockServer.setTokenResponse({
      access_token: "mock_access_token_abc123",
      refresh_token: "mock_refresh_token_xyz789",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read write",
    });
    mockServer.setTokenStatus(200);

    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    appId = defaultAppId;
    actor = { type: "user", id: userId };

    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    profileId = profile.id;

    await seedOAuth2Provider(orgId, PROVIDER_ID);
    await seedProviderCredentialsForApp(PROVIDER_ID, appId, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  });

  // ── initiateConnection ────────────────────────────────────

  describe("initiateConnection", () => {
    it("returns an auth URL with required OAuth2 params", async () => {
      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      expect(result.authUrl).toBeString();
      expect(result.state).toBeString();

      const url = new URL(result.authUrl);
      expect(url.origin + url.pathname).toBe(`${mockServer.url}/authorize`);
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBeString();
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBe(result.state);
    });

    it("includes PKCE code_challenge and method when pkce is enabled", async () => {
      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      const url = new URL(result.authUrl);
      expect(url.searchParams.get("code_challenge")).toBeString();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("includes scopes in the auth URL", async () => {
      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      const url = new URL(result.authUrl);
      const scope = url.searchParams.get("scope");
      expect(scope).toContain("read");
      expect(scope).toContain("write");
    });

    it("merges default and requested scopes", async () => {
      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
        ["admin", "read"],
      );

      const url = new URL(result.authUrl);
      const scope = url.searchParams.get("scope");
      expect(scope).toContain("read");
      expect(scope).toContain("write");
      expect(scope).toContain("admin");
    });

    it("stores state in the oauth state store", async () => {
      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      const row = await oauthStateStore.get(result.state);
      expect(row).not.toBeNull();
      expect(row!.orgId).toBe(orgId);
      expect(row!.userId).toBe(userId);
      expect(row!.profileId).toBe(profileId);
      expect(row!.providerId).toBe(PROVIDER_ID);
      expect(row!.codeVerifier).toBeString();
      expect(row!.codeVerifier.length).toBeGreaterThan(10);
      expect(row!.redirectUri).toBeString();
      expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("stores a unique state per invocation", async () => {
      const r1 = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      const r2 = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      expect(r1.state).not.toBe(r2.state);
    });

    it("throws when provider does not exist", async () => {
      await expect(
        initiateConnection(
          { orgId: orgId, applicationId: appId },
          "@testorg/nonexistent",
          actor,
          profileId,
        ),
      ).rejects.toThrow("not found");
    });

    it("throws when no OAuth credentials are configured", async () => {
      // Seed a second provider without credentials
      await seedOAuth2Provider(orgId, "@testorg/no-creds-provider");

      await expect(
        initiateConnection(
          { orgId: orgId, applicationId: appId },
          "@testorg/no-creds-provider",
          actor,
          profileId,
        ),
      ).rejects.toThrow("No OAuth credentials configured");
    });
  });

  // ── handleCallback (full flow) ────────────────────────────

  describe("handleCallback", () => {
    it("exchanges code for tokens and stores the connection", async () => {
      // Step 1: Initiate to create the state
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      // Step 2: Handle callback with a mock code
      const result = await handleCallback("mock-auth-code-123", state);

      expect(result.providerId).toBe(PROVIDER_ID);
      expect(result.orgId).toBe(orgId);
      expect(result.profileId).toBe(profileId);
      expect(result.accessToken).toBe("mock_access_token_abc123");
      expect(result.refreshToken).toBe("mock_refresh_token_xyz789");
      expect(result.scopesGranted).toContain("read");
      expect(result.scopesGranted).toContain("write");
    });

    it("sends correct token exchange request to the provider", async () => {
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      mockServer.clearRequests(); // Clear the initiate-phase requests

      await handleCallback("the-auth-code", state);

      // Find the POST /token request
      const tokenReq = mockServer.requests.find((r) => r.method === "POST" && r.path === "/token");
      expect(tokenReq).toBeDefined();

      const body = new URLSearchParams(tokenReq!.body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-auth-code");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe(CLIENT_SECRET);
      expect(body.get("redirect_uri")).toBeString();
      // PKCE code_verifier should be present
      expect(body.get("code_verifier")).toBeString();
      expect(body.get("code_verifier")!.length).toBeGreaterThan(10);
    });

    it("saves encrypted credentials in user_provider_connections", async () => {
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      await handleCallback("mock-code", state);

      const rows = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));

      expect(rows).toHaveLength(1);
      const conn = rows[0]!;
      expect(conn.providerId).toBe(PROVIDER_ID);
      expect(conn.orgId).toBe(orgId);

      // Credentials are encrypted (not plaintext)
      expect(conn.credentialsEncrypted).not.toContain("mock_access_token");

      // Decrypts to the mock token values
      const decrypted = decryptCredentials<Record<string, string>>(conn.credentialsEncrypted);
      expect(decrypted.access_token).toBe("mock_access_token_abc123");
      expect(decrypted.refresh_token).toBe("mock_refresh_token_xyz789");
    });

    it("cleans up oauth state after successful callback", async () => {
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      await handleCallback("mock-code", state);

      const row = await oauthStateStore.get(state);
      expect(row).toBeNull();
    });

    it("throws on invalid state", async () => {
      await expect(handleCallback("mock-code", "nonexistent-state-value")).rejects.toThrow(
        "Invalid or expired OAuth state",
      );
    });

    it("throws on expired state", async () => {
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      // Evict from the store to simulate TTL expiry
      await oauthStateStore.delete(state);

      await expect(handleCallback("mock-code", state)).rejects.toThrow(/[Ii]nvalid|[Ee]xpired/);
    });

    it("throws when token exchange returns an error status", async () => {
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({ error: "invalid_grant" });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      await expect(handleCallback("bad-code", state)).rejects.toThrow("Token exchange failed");
    });

    // The two paths that hit the token endpoint (initial callback + refresh) MUST
    // classify a `400 invalid_grant` as a revocation per RFC 6749 §5.2 — historically
    // only the refresh path did this, leaving the callback to surface a generic 400
    // with no actionable signal.
    it("classifies invalid_grant on the initial callback as a revocation (kind=revoked)", async () => {
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({
        error: "invalid_grant",
        error_description: "Authorization code expired",
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      let caught: unknown;
      try {
        await handleCallback("bad-code", state);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OAuthCallbackError);
      const cbErr = caught as OAuthCallbackError;
      expect(cbErr.kind).toBe("revoked");
      expect(cbErr.providerId).toBe(PROVIDER_ID);
      expect(cbErr.oauthError).toBe("invalid_grant");
      expect(cbErr.oauthErrorDescription).toBe("Authorization code expired");
    });

    it("classifies non-invalid_grant 400 errors as transient", async () => {
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({ error: "invalid_client" });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      let caught: unknown;
      try {
        await handleCallback("bad-code", state);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OAuthCallbackError);
      expect((caught as OAuthCallbackError).kind).toBe("transient");
    });

    // Regression: an earlier version concatenated the raw IdP body into
    // the error message — some IdPs echo the rejected `code` (or other
    // request fields) back in 400 bodies, so a generic catcher logging
    // `err.message` would surface them. The body now lives ONLY on the
    // typed `body` field.
    it("never leaks the raw IdP body into err.message; preserves it on err.body", async () => {
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({
        error: "invalid_grant",
        error_description: "Authorization code expired",
        // Some IdPs echo the rejected code or other sensitive request
        // fields. Synthesise that here to assert it never reaches
        // err.message.
        echoed_code: "leaked-secret-AAA-BBB-CCC",
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      let caught: unknown;
      try {
        await handleCallback("bad-code", state);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OAuthCallbackError);
      const cbErr = caught as OAuthCallbackError;

      // Body is preserved verbatim on the typed field for diagnostics.
      expect(cbErr.body).toContain("leaked-secret-AAA-BBB-CCC");

      // Message must NOT contain anything the IdP echoed back. The
      // summary is built from `oauthError` + `oauthErrorDescription`
      // only, both of which the connection layer treats as
      // already-classified strings.
      expect(cbErr.message).not.toContain("leaked-secret-AAA-BBB-CCC");
      expect(cbErr.message).toContain("invalid_grant");
      expect(cbErr.message).toContain("Authorization code expired");
    });

    // Regression: PKCE state used to linger in Redis for the full
    // 10-minute TTL on a `revoked` callback failure even though the
    // auth code was already dead at the IdP. Hygiene: delete the row
    // on revoked outcomes (we keep it on `transient` so retry of the
    // same code stays possible for transient 5xx).
    it("deletes the OAuth state row on a revoked callback failure", async () => {
      mockServer.setTokenStatus(400);
      mockServer.setTokenResponse({ error: "invalid_grant" });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      // State row exists pre-callback.
      const before = await oauthStateStore.get(state);
      expect(before).not.toBeNull();

      try {
        await handleCallback("bad-code", state);
      } catch {
        /* expected revoked */
      }

      // State row reaped after a revoked outcome.
      const after = await oauthStateStore.get(state);
      expect(after).toBeNull();
    });

    it("preserves the OAuth state row on a transient callback failure", async () => {
      mockServer.setTokenStatus(500);
      mockServer.setTokenResponse({ error: "server_error" });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      try {
        await handleCallback("bad-code", state);
      } catch {
        /* expected transient */
      }

      // Row preserved so a retry of the same code (for genuine 5xx)
      // remains possible within the TTL window.
      const after = await oauthStateStore.get(state);
      expect(after).not.toBeNull();
    });

    it("throws when token response has no access_token", async () => {
      mockServer.setTokenResponse({ token_type: "Bearer" });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      await expect(handleCallback("mock-code", state)).rejects.toThrow("No access_token");
    });

    it("handles token response without refresh_token", async () => {
      mockServer.setTokenResponse({
        access_token: "only_access_token",
        token_type: "Bearer",
        expires_in: 7200,
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      const result = await handleCallback("mock-code", state);

      expect(result.accessToken).toBe("only_access_token");
      expect(result.refreshToken).toBeUndefined();
    });

    it("handles token response with scope different from requested", async () => {
      mockServer.setTokenResponse({
        access_token: "token",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      const result = await handleCallback("mock-code", state);

      // scopesGranted reflects what the token endpoint returned, not what was requested
      expect(result.scopesGranted).toEqual(["read"]);
      // The provider granted "read" but we requested ["read", "write"] →
      // shortfall surfaces "write".
      expect(result.scopeShortfall).toEqual(["write"]);
    });

    it("flags the saved connection with needsReconnection on scope shortfall", async () => {
      mockServer.setTokenResponse({
        access_token: "token",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read", // only "read" granted, but ["read","write"] requested
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      await handleCallback("mock-code", state);

      const [conn] = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));
      expect(conn).toBeDefined();
      expect(conn!.needsReconnection).toBe(true);
      expect(conn!.scopesGranted).toEqual(["read"]);
    });

    it("does NOT flag needsReconnection on scope creep (provider over-grant)", async () => {
      mockServer.setTokenResponse({
        access_token: "token",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write admin", // extra "admin" beyond the requested set
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );
      const result = await handleCallback("mock-code", state);
      expect(result.scopeCreep).toEqual(["admin"]);
      expect(result.scopeShortfall).toEqual([]);

      const [conn] = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));
      expect(conn!.needsReconnection).toBe(false);
    });
  });

  // ── PKCE verification ─────────────────────────────────────

  describe("PKCE flow", () => {
    it("sends the stored code_verifier in the token exchange", async () => {
      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        PROVIDER_ID,
        actor,
        profileId,
      );

      const stateRow = await oauthStateStore.get(state);
      const storedVerifier = stateRow!.codeVerifier;

      mockServer.clearRequests();
      await handleCallback("mock-code", state);

      const tokenReq = mockServer.requests.find((r) => r.method === "POST" && r.path === "/token");
      const body = new URLSearchParams(tokenReq!.body);
      expect(body.get("code_verifier")).toBe(storedVerifier);
    });

    it("omits PKCE params when pkceEnabled is false", async () => {
      const noPkceProvider = "@testorg/no-pkce-provider";
      await seedOAuth2Provider(orgId, noPkceProvider, { pkceEnabled: false });
      await seedProviderCredentialsForApp(noPkceProvider, appId, {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });

      const { authUrl, state } = await initiateConnection(
        { orgId, applicationId: appId },
        noPkceProvider,
        actor,
        profileId,
      );

      // Auth URL should not have code_challenge
      const url = new URL(authUrl);
      expect(url.searchParams.get("code_challenge")).toBeNull();
      expect(url.searchParams.get("code_challenge_method")).toBeNull();

      // Token exchange should not have code_verifier
      mockServer.clearRequests();
      await handleCallback("mock-code", state);

      const tokenReq = mockServer.requests.find((r) => r.method === "POST" && r.path === "/token");
      const body = new URLSearchParams(tokenReq!.body);
      expect(body.get("code_verifier")).toBeNull();
    });
  });

  // ── Token auth methods ────────────────────────────────────

  describe("token auth methods", () => {
    it("sends client_secret_basic as Authorization header", async () => {
      const basicProvider = "@testorg/basic-auth-provider";
      await seedOAuth2Provider(orgId, basicProvider, {
        tokenAuthMethod: "client_secret_basic",
      });
      await seedProviderCredentialsForApp(basicProvider, appId, {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });

      const { state } = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        basicProvider,
        actor,
        profileId,
      );

      mockServer.clearRequests();
      await handleCallback("mock-code", state);

      const tokenReq = mockServer.requests.find((r) => r.method === "POST" && r.path === "/token");
      expect(tokenReq).toBeDefined();

      // Should have Authorization: Basic header
      const authHeader = tokenReq!.headers["authorization"];
      expect(authHeader).toStartWith("Basic ");

      // Decode and verify it contains clientId:clientSecret
      const decoded = Buffer.from(authHeader!.replace("Basic ", ""), "base64").toString();
      expect(decoded).toContain(CLIENT_ID);
      expect(decoded).toContain(CLIENT_SECRET);

      // Should NOT have client_id/client_secret in body
      const body = new URLSearchParams(tokenReq!.body);
      expect(body.get("client_id")).toBeNull();
      expect(body.get("client_secret")).toBeNull();
    });
  });

  // ── System provider (orgId: null) ─────────────────────────

  describe("system provider", () => {
    it("resolves a system provider (orgId null) for any org", async () => {
      const systemProvider = "@system/gmail";
      await seedOAuth2Provider(null, systemProvider);
      await seedProviderCredentialsForApp(systemProvider, appId, {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });

      const result = await initiateConnection(
        { orgId: orgId, applicationId: appId },
        systemProvider,
        actor,
        profileId,
      );
      expect(result.authUrl).toContain("/authorize");
      expect(result.state).toBeString();
    });
  });
});
