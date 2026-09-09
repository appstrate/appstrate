// SPDX-License-Identifier: Apache-2.0

/**
 * Dynamic Client Registration (RFC 7591) + CIMD discovery advertisement, the
 * zero-config OAuth onboarding paths for generic MCP clients (issue #613).
 *
 * Covers the authorization-server surface:
 *  - `/.well-known/oauth-authorization-server` advertises
 *    `client_id_metadata_document_supported: true` (CIMD, via the cimd()
 *    plugin) and a `registration_endpoint` (DCR).
 *  - Unauthenticated DCR registers a public client and bounds requested
 *    scopes to the self-service set (identity + module scopes); a core action
 *    scope is rejected.
 *
 * CIMD first authorization also exercises the real resolver with an in-process
 * metadata response, ensuring our self-service stamp reaches that request —
 * including the exact request Claude Code sends (module scopes + `resource`,
 * issue #1269), which must complete on its FIRST resolution, never on a retry.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import * as cimdTransport from "@better-auth/cimd/node";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient, oauthResource } from "@appstrate/db/schema";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";
import { decodeJwt } from "jose";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestOrg, createTestUser } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import {
  registerProtectedResourceFamily,
  resetProtectedResources,
  snapshotProtectedResources,
  restoreProtectedResources,
} from "../../../../../lib/protected-resources.ts";
import { getMcpOrgResourceUri, orgIdFromMcpAudience } from "../../../../../lib/audiences.ts";
import { getEnv } from "@appstrate/env";
import { OIDC_IDENTITY_SCOPES } from "../../../auth/scopes.ts";
import oidcModule from "../../../index.ts";
import { APPSTRATE_CLI_CLIENT_ID, ensureCliClient } from "../../../services/ensure-cli-client.ts";

const app = getTestApp({ modules: [oidcModule] });

// The protected-resource registry is a process-wide singleton shared with the
// live app. Snapshot before this file mutates it and restore afterwards so a
// later test file's MCP registration is not clobbered (cross-file order-safe).
let protectedResourcesSnapshot: ReturnType<typeof snapshotProtectedResources>;
beforeAll(() => {
  protectedResourcesSnapshot = snapshotProtectedResources();
});
afterAll(() => {
  restoreProtectedResources(protectedResourcesSnapshot);
});

async function register(body: Record<string, unknown>) {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/**
 * The per-org MCP protected-resource family the mcp module registers at init.
 * Registered directly so the self-service audience guards
 * (`isProtectedResourceUri`) have a family to compare against without loading
 * the full mcp dispatch surface.
 */
function registerMcpOrgFamily(): void {
  resetProtectedResources();
  registerProtectedResourceFamily({
    prefix: "/api/mcp/o",
    deriveUri: (path) => {
      const prefix = "/api/mcp/o/";
      if (!path.startsWith(prefix)) return undefined;
      const orgId = path.slice(prefix.length).split("/")[0] ?? "";
      return orgId.length === 0 ? undefined : getMcpOrgResourceUri(orgId);
    },
    ownsUri: (uri) => orgIdFromMcpAudience(uri) !== undefined,
  });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function signUpPlatformUser(email: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Sup3rSecretPass!", name: "Operator" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie: ${setCookie}`);
  return `better-auth.session_token=${match[1]}`;
}

interface AuthorizationCodeFlowInput {
  cookie: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
}

interface AuthorizationCodeFlowResult {
  /** Whether the consent screen stood between authorize and the code. */
  consentShown: boolean;
  /** The `/oauth2/token` JSON response. */
  token: Record<string, unknown>;
  /** The decoded access token. */
  claims: Record<string, unknown>;
}

/**
 * Full authorization-code + PKCE exchange as a signed-in platform user:
 * authorize → consent (unless a stored consent short-circuits it) → token.
 */
async function authorizationCodeFlow(
  input: AuthorizationCodeFlowInput,
): Promise<AuthorizationCodeFlowResult> {
  const { cookie, clientId, redirectUri, scope, resource } = input;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "authorization-code-flow",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource,
  });
  const authorized = await app.request(`/api/auth/oauth2/authorize?${authorizeQuery}`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(authorized.status).toBe(302);
  const authorizeTarget = new URL(authorized.headers.get("location")!, "http://localhost");
  // An `error` here is the provider bouncing the request back to the client
  // (`invalid_scope`, `invalid_target`, …) — name it instead of failing on the
  // missing code below.
  expect(authorizeTarget.searchParams.get("error")).toBeNull();

  // A stored consent short-circuits the consent screen and the authorization
  // response comes straight back on the callback.
  const consentShown = authorizeTarget.pathname === "/api/oauth/consent";
  let callback = authorizeTarget;
  if (consentShown) {
    const consentPage = await app.request(authorizeTarget.pathname + authorizeTarget.search, {
      headers: { cookie, accept: "text/html" },
    });
    expect(consentPage.status).toBe(200);
    const csrfCookie = (consentPage.headers.get("set-cookie") ?? "")
      .split(",")
      .map((c) => c.trim())
      .find((c) => c.startsWith("oidc_csrf="))!
      .split(";")[0]!;
    const csrfToken = (await consentPage.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

    const consented = await app.request(authorizeTarget.pathname + authorizeTarget.search, {
      method: "POST",
      headers: {
        cookie: `${cookie}; ${csrfCookie}`,
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
        origin: "http://localhost:3000",
      },
      body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
      redirect: "manual",
    });
    expect([200, 302]).toContain(consented.status);
    const location = consented.headers.get("location");
    callback = location
      ? new URL(location, redirectUri)
      : new URL(String(((await consented.json()) as { url?: string }).url));
  }
  expect(callback.searchParams.get("error")).toBeNull();
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  const token = (await tokenRes.json()) as Record<string, unknown>;
  expect(token).not.toHaveProperty("error");
  expect(tokenRes.status).toBe(200);
  const claims = decodeJwt(String(token.access_token)) as Record<string, unknown>;
  return { consentShown, token, claims };
}

describe("authorization-server discovery — DCR + CIMD", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
  });

  it("advertises CIMD support and a registration endpoint", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(typeof body.registration_endpoint).toBe("string");
    expect(String(body.registration_endpoint)).toContain("/oauth2/register");
  });
});

describe("CIMD first authorization", () => {
  // A public IP keeps the real client_id URL check (upstream refuses private
  // and reserved addresses) but avoids external DNS. The transport below serves
  // the document in-process; no request reaches this address.
  //
  // One address PER TEST, not one for the suite: the resolver keeps an
  // in-process document cache keyed on client_id (60m default revalidation)
  // and the plugin is built once at boot, so a shared URL would serve a later
  // test the document an earlier one registered — the DB truncation does not
  // reach that cache, and the test would silently stop discriminating.
  let addressOctet = 0;
  let clientId: string;
  let redirectUri: string;
  let documentScope: string | undefined;
  let fetchDocument: ReturnType<typeof spyOn<typeof cimdTransport, "fetchClientMetadataResource">>;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    addressOctet += 1;
    clientId = `https://93.184.216.${addressOctet}/client.json`;
    redirectUri = `https://93.184.216.${addressOctet}/callback`;
    documentScope = undefined;
    // The metadata document is fetched through `@better-auth/cimd/node` — the
    // resolve-once, address-pinning, redirect-refusing transport the plugin
    // requires — not through `globalThis.fetch`, so that is what is replaced
    // here. The platform reads the binding per request (see `plugins.ts`).
    fetchDocument = spyOn(cimdTransport, "fetchClientMetadataResource").mockImplementation(
      async (input) => {
        expect(String(input)).toBe(clientId);
        return Response.json({
          client_id: clientId,
          client_name: "CIMD first authorization",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(documentScope === undefined ? {} : { scope: documentScope }),
        });
      },
    );
  });

  afterEach(() => {
    fetchDocument.mockRestore();
  });

  async function authorize(scope: string) {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "first-cimd-authorization",
    });
    return app.request(`/api/auth/oauth2/authorize?${query}`);
  }

  async function storedClient() {
    const [stored] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    if (!stored) throw new Error("CIMD client was not persisted");
    return stored;
  }

  it("registers a document without scope at the self-service ceiling and stamps it", async () => {
    expect(await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId))).toEqual(
      [],
    );

    const first = await authorize("openid offline_access");
    const retry = await authorize("openid offline_access");

    for (const res of [first, retry]) {
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe(
        "/api/oauth/login",
      );
    }
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    const stored = await storedClient();
    // Same literals as the DCR sibling below: `mcp` is the only module
    // contributing end-user scopes today and `getTestApp({ modules: [oidcModule] })`
    // narrows the live provider. A superset assertion, so a second module
    // opting in stays green — but `agents:run` must stay out.
    expect(stored.scopes).toEqual(
      expect.arrayContaining([...OIDC_IDENTITY_SCOPES, "mcp:read", "mcp:invoke"]),
    );
    expect(stored.scopes).not.toContain("agents:run");
    expect(stored.level).toBe("instance");
    expect(stored.selfService).toBe(true);
  });

  it("grants the ceiling to a document that declares a narrower scope", async () => {
    // A registration `scope` is VALIDATED against the self-service ceiling and
    // then replaced by it — the declared value is never what gets persisted
    // (`persistOAuthClientRegistration`). A document narrowing itself to
    // `openid` therefore still ends up able to request the whole self-service
    // set. That is not a widening of the trust boundary: our
    // `clientRegistrationDefaultScopes` and `clientRegistrationAllowedScopes`
    // are the SAME set, so a document declaring no scope at all already
    // reached it. The real gate stays the ceiling (asserted below and in the
    // DCR suite), the consent screen, and the caller's own permissions.
    documentScope = "openid";

    const authorized = await authorize("openid offline_access");
    expect(new URL(authorized.headers.get("location")!, "http://localhost").pathname).toBe(
      "/api/oauth/login",
    );
    const stored = await storedClient();
    expect(stored.scopes).toEqual(
      expect.arrayContaining([...OIDC_IDENTITY_SCOPES, "mcp:read", "mcp:invoke"]),
    );
    expect(stored.scopes).not.toContain("agents:run");
    // Second pass reads the cached/persisted client — no second document fetch.
    await authorize("openid");
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("does not grant a core action scope to a document without scopes", async () => {
    const rejected = await authorize("openid agents:run");
    expect(new URL(rejected.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_scope",
    );
    expect((await storedClient()).scopes).not.toContain("agents:run");
  });

  it("keeps a newly discovered client confined to protected-resource audiences", async () => {
    await authorize("openid offline_access");

    const token = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: "irrelevant-code",
        code_verifier: "a".repeat(43),
        resource: getEnv().APP_URL,
      }).toString(),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_target" });
  });
});

describe("CIMD first authorization — the request Claude Code sends (#1269)", () => {
  // Claude Code identifies by a CIMD URL and publishes a document WITHOUT
  // `scope`. Its very first `/authorize` asks for exactly what the protected
  // resource metadata advertises (`mcp:read mcp:invoke`) plus `offline_access`,
  // bound to one per-org MCP endpoint through `resource`, from an
  // ephemeral-port loopback redirect against a port-less registration.
  //
  // Before better-auth 1.7.3 the client object handed to that first request
  // carried `scopes: []` — the ceiling reached the row only afterwards, through
  // `onClientCreated` — so the first attempt bounced with `invalid_scope` and
  // the retry succeeded. The provider now persists the self-service ceiling in
  // the same write that creates the client (`persistOAuthClientRegistration`),
  // and the suite above asserts the stored row. This suite pins the
  // user-visible contract on the FIRST resolution: login, consent, code,
  // token — never a retry.
  const REQUESTED_SCOPE = "mcp:read mcp:invoke offline_access";
  const REDIRECT_URI = "http://localhost:53692/callback";
  let documentOctet = 200;
  let clientId: string;
  let orgUri: string;
  let fetchDocument: ReturnType<typeof spyOn<typeof cimdTransport, "fetchClientMetadataResource">>;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // A distinct address per test: the document cache is keyed on client_id and
    // outlives `truncateAll()`. A never-seen client_id is the whole point here.
    documentOctet += 1;
    clientId = `https://93.184.216.${documentOctet}/oauth/claude-code-client-metadata`;
    const { id: ownerId } = await createTestUser();
    const { org } = await createTestOrg(ownerId, { slug: "claude-code-first" });
    orgUri = getMcpOrgResourceUri(org.id);
    fetchDocument = spyOn(cimdTransport, "fetchClientMetadataResource").mockImplementation(
      async (input) => {
        expect(String(input)).toBe(clientId);
        return Response.json({
          client_id: clientId,
          client_name: "Claude Code",
          client_uri: `https://93.184.216.${documentOctet}`,
          // Port-less loopback redirects: the port is ephemeral (RFC 8252 §7.3).
          redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      },
    );
    registerMcpOrgFamily();
    await db
      .insert(oauthResource)
      .values({ id: crypto.randomUUID(), identifier: orgUri, name: "MCP endpoint (#1269)" })
      .onConflictDoNothing({ target: oauthResource.identifier });
  });

  afterEach(async () => {
    fetchDocument.mockRestore();
    await db.delete(oauthResource).where(eq(oauthResource.identifier, orgUri));
  });

  function authorize() {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: REQUESTED_SCOPE,
      state: "claude-code-first",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: orgUri,
    });
    return app.request(`/api/auth/oauth2/authorize?${query}`, { redirect: "manual" });
  }

  it("sends the anonymous first request to the login page, not back with invalid_scope", async () => {
    expect(await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId))).toEqual(
      [],
    );

    const first = await authorize();
    expect(first.status).toBe(302);
    const target = new URL(first.headers.get("location")!, "http://localhost");
    expect(target.searchParams.get("error")).toBeNull();
    expect(target.pathname).toBe("/api/oauth/login");
    // The login hand-off carries the request unchanged — scopes and audience.
    expect(target.searchParams.get("scope")).toBe(REQUESTED_SCOPE);
    expect(target.searchParams.get("resource")).toBe(orgUri);

    // One resolution: the document was fetched once, and the row it created
    // already carries the module scopes the request asked for.
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    const [stored] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    expect(stored?.scopes).toEqual(
      expect.arrayContaining(["mcp:read", "mcp:invoke", "offline_access"]),
    );
    expect(stored?.level).toBe("instance");
    expect(stored?.selfService).toBe(true);

    // The retry the user used to need is now indistinguishable from the first.
    const retry = await authorize();
    expect(new URL(retry.headers.get("location")!, "http://localhost").pathname).toBe(
      "/api/oauth/login",
    );
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("reaches consent and mints the MCP-scoped token on the first resolution", async () => {
    const cookie = await signUpPlatformUser("claude-code-first@satellite.example.com");

    const { consentShown, token, claims } = await authorizationCodeFlow({
      cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: REQUESTED_SCOPE,
      resource: orgUri,
    });

    // A never-seen client has no stored consent: the screen is unavoidable.
    expect(consentShown).toBe(true);
    // The whole flow ran on the single resolution that created the client.
    expect(fetchDocument).toHaveBeenCalledTimes(1);

    const granted = String(token.scope).split(" ");
    expect(granted).toEqual(expect.arrayContaining(["mcp:read", "mcp:invoke"]));
    expect(granted).not.toContain("agents:run");
    // `offline_access` was honoured: the client can refresh without a browser.
    expect(typeof token.refresh_token).toBe("string");
    // Bound to the one per-org MCP endpoint it asked for.
    expect([claims.aud].flat()).toContain(orgUri);
    expect(String(claims.scope).split(" ")).toEqual(
      expect.arrayContaining(["mcp:read", "mcp:invoke"]),
    );
    expect(claims.actor_type).toBe("user");
  });
});

describe("Dynamic Client Registration (RFC 7591)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
  });

  async function authorizeClient(clientId: string, redirectUri: string, scope: string) {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "dcr-authorization",
    });
    return app.request(`/api/auth/oauth2/authorize?${query}`);
  }

  it("defaults to a native client so loopback redirects register, but honours a declared web", async () => {
    // `claude mcp add` and `npx @appstrate/connect-helper` listen on an
    // ephemeral loopback port and declare no `application_type`. The
    // oauth-provider validates redirect URIs against that type and assumes
    // `web` — https on a non-loopback host only — for a DCR body that declares
    // nothing, which refuses every one of those callbacks. The register
    // before-hook fills the ABSENT field with `native`, the same default the
    // CIMD path already gets (RFC 8252 §7.3).
    const loopback = await register({
      client_name: "Loopback MCP client",
      redirect_uris: ["http://127.0.0.1:9917/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect([200, 201]).toContain(loopback.status);
    expect(loopback.json.application_type).toBe("native");

    // A declared value is never overwritten: a client that says it is a web
    // client is still held to https on a non-loopback host.
    const declaredWeb = await register({
      client_name: "Web client on loopback",
      redirect_uris: ["http://127.0.0.1:9918/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(declaredWeb.status).toBe(400);
    expect(String(declaredWeb.json.error)).toBe("invalid_redirect_uri");
  });

  it("defaults a scope-less registration to the self-service set and authorizes it", async () => {
    const redirectUri = "http://localhost:9915/callback";
    const { status, json } = await register({
      client_name: "MCP client (no scope)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect([200, 201]).toContain(status);
    // `mcp` is the only module contributing end-user scopes today, and
    // `getTestApp({ modules: [oidcModule] })` narrows the live provider — hence
    // the literals. A superset, so a second module opting in stays green.
    const scopes = String(json.scope).split(" ");
    expect(scopes).toEqual(
      expect.arrayContaining([...OIDC_IDENTITY_SCOPES, "mcp:read", "mcp:invoke"]),
    );
    expect(scopes).not.toContain("agents:run");

    const authorized = await authorizeClient(
      String(json.client_id),
      redirectUri,
      "mcp:read mcp:invoke offline_access",
    );
    expect(authorized.status).toBe(302);
    expect(new URL(authorized.headers.get("location")!, "http://localhost").pathname).toBe(
      "/api/oauth/login",
    );
  });

  it("grants the ceiling to a registration that declares a narrower scope", async () => {
    // RFC 7591 §3.2.1 lets the AS answer with a scope different from the one
    // requested. The oauth-provider validates the declared `scope` against the
    // self-service ceiling and then persists the ceiling itself, so a narrow
    // declaration is not retained. Harmless here because
    // `clientRegistrationDefaultScopes` and `clientRegistrationAllowedScopes`
    // are the SAME set — a body with no `scope` at all (the test above)
    // already reached the ceiling, so nothing an attacker would have declared
    // changes what they get. The gates that hold are the ceiling itself (test
    // below), the consent screen, and the caller's permissions.
    const redirectUri = "http://localhost:9916/callback";
    const { status, json } = await register({
      client_name: "Narrow client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid",
    });
    expect([200, 201]).toContain(status);
    expect(typeof json.client_id).toBe("string");
    // Public client (PKCE) — registered with no client authentication method.
    expect(json.token_endpoint_auth_method ?? "none").toBe("none");
    const scopes = String(json.scope).split(" ");
    expect(scopes).toEqual(
      expect.arrayContaining([...OIDC_IDENTITY_SCOPES, "mcp:read", "mcp:invoke"]),
    );
    expect(scopes).not.toContain("agents:run");

    const authorized = await authorizeClient(String(json.client_id), redirectUri, "mcp:read");
    expect(authorized.status).toBe(302);
    expect(new URL(authorized.headers.get("location")!, "http://localhost").pathname).toBe(
      "/api/oauth/login",
    );
  });

  it("rejects a registration requesting a core action scope outside the self-service set", async () => {
    // agents:run is a valid AS scope (advertised in scopes_supported) and is
    // grantable to admin-managed clients, but NOT via self-service DCR —
    // clientRegistrationAllowedScopes is bounded to identity + module scopes.
    const { status, json } = await register({
      client_name: "Overreaching client",
      redirect_uris: ["http://localhost:9912/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid agents:run",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toBe("invalid_scope");
  });

  it("stamps a DCR client as a self-service instance client (so token mint does not reject)", async () => {
    // A registered client with no platform level makes the claim builder throw
    // "cannot issue token" on EVERY exchange. The register after-hook stamps the
    // two columns the builder and the audience guard read.
    const { status, json } = await register({
      client_name: "Claude Code (mint-regression)",
      redirect_uris: ["http://localhost:9913/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    });
    expect([200, 201]).toContain(status);
    const clientId = String(json.client_id);

    const [row] = await db
      .select({ level: oauthClient.level, selfService: oauthClient.selfService })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.level).toBe("instance");
    expect(row!.selfService).toBe(true);
  });

  it("takes level and self-service from the columns, never from a body `metadata`", async () => {
    // The RFC 7591 body schema is loose, so a registrant can post a top-level
    // `metadata` object and the provider persists it verbatim. Declaring
    // `selfService: false` there would lift the single-protected-resource cage,
    // and `level: "org"` would change the claim shape — neither is read.
    const { status, json } = await register({
      client_name: "Client that names its own level",
      redirect_uris: ["http://localhost:9919/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      metadata: { selfService: false, level: "org", referencedOrgId: crypto.randomUUID() },
    });
    expect([200, 201]).toContain(status);

    const [row] = await db
      .select({ level: oauthClient.level, selfService: oauthClient.selfService })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, String(json.client_id)))
      .limit(1);
    expect(row!.level).toBe("instance");
    expect(row!.selfService).toBe(true);
  });

  it("fills an `application_type` that is present but null", async () => {
    // `"application_type" in body` reads an explicit null as declared, leaving
    // the provider to reject the body — a loopback MCP client that serialises
    // its absent fields as null could not register at all.
    const { status, json } = await register({
      client_name: "Null application type",
      redirect_uris: ["http://127.0.0.1:9920/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: null,
    });
    expect([200, 201]).toContain(status);
    expect(json.application_type).toBe("native");
  });
});

describe("self-service token audience restriction (RFC 8707 / RFC 9728)", () => {
  // A fixed org whose per-org MCP resource the self-service client may target.
  const ORG_ID = "00000000-0000-0000-0000-0000000000c1";

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // This suite asserts only the token-endpoint guard
    // (`enforceSelfServiceResourceRestriction`): it stops at the before-hook
    // verdict, so the org needs no `oauth_resources` row.
    registerMcpOrgFamily();
  });

  async function registerSelfServiceClient(): Promise<string> {
    const { status, json } = await register({
      client_name: "Claude Code (audience)",
      redirect_uris: ["http://localhost:9914/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    });
    expect([200, 201]).toContain(status);
    return String(json.client_id);
  }

  async function tokenWithResource(clientId: string, resource: string) {
    // The resource restriction runs in the `/oauth2/token` before-hook, ahead
    // of code validation — a syntactically-present but invalid code is enough
    // to reach (and assert) the resource gate without a full PKCE dance.
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "irrelevant-code",
        client_id: clientId,
        redirect_uri: "http://localhost:9914/callback",
        code_verifier: "x".repeat(43),
        resource,
      }).toString(),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  it("rejects a self-service client requesting the broad platform audience (APP_URL)", async () => {
    const clientId = await registerSelfServiceClient();
    const { status, json } = await tokenWithResource(clientId, getEnv().APP_URL);
    expect(status).toBe(400);
    expect(String(json.error)).toBe("invalid_target");
  });

  it("rejects a self-service client requesting the AS audience (APP_URL/api/auth)", async () => {
    const clientId = await registerSelfServiceClient();
    const { status, json } = await tokenWithResource(clientId, `${getEnv().APP_URL}/api/auth`);
    expect(status).toBe(400);
    expect(String(json.error)).toBe("invalid_target");
  });

  it("allows a self-service client to request a per-org MCP protected-resource audience", async () => {
    const clientId = await registerSelfServiceClient();
    const { status, json } = await tokenWithResource(clientId, getMcpOrgResourceUri(ORG_ID));
    // The self-service gate passes for the per-org MCP audience (registered
    // family); the request still fails downstream on the bogus code — but NOT
    // with our `invalid_target`.
    expect(String(json.error ?? "")).not.toBe("invalid_target");
    if (status === 400) expect(String(json.error)).not.toBe("invalid_target");
  });

  // `private_key_jwt` carries the client id INSIDE the `client_assertion`
  // (RFC 7523 §3), which is where the before-hook reads it from. An assertion
  // naming nobody identifies no client, and is held to the same confinement —
  // otherwise dropping `client_id` would be the way to an instance-wide
  // audience.

  /** JWT-shaped; the guard reads the payload and never verifies the signature. */
  function unsignedAssertion(claims: Record<string, unknown>): string {
    const segment = (value: object) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(claims)}.c2ln`;
  }

  async function tokenWithAssertion(resource: string, claims: Record<string, unknown>) {
    const res = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "irrelevant-code",
        redirect_uri: "http://localhost:9914/callback",
        code_verifier: "x".repeat(43),
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: unsignedAssertion(claims),
        resource,
      }).toString(),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  it("rejects the broad platform audience when the request names no client_id", async () => {
    const { status, json } = await tokenWithAssertion(getEnv().APP_URL, { jti: "no-subject" });
    expect(status).toBe(400);
    expect(String(json.error)).toBe("invalid_target");
  });

  it("lets a per-org MCP audience past the gate when the request names no client_id", async () => {
    const { json } = await tokenWithAssertion(getMcpOrgResourceUri(ORG_ID), { jti: "no-subject" });
    // Past our gate — whatever the provider then says about the unverifiable
    // assertion, it is not `invalid_target`.
    expect(String(json.error ?? "")).not.toBe("invalid_target");
  });

  it("confines a self-service client that names itself in its assertion", async () => {
    const clientId = await registerSelfServiceClient();
    const { status, json } = await tokenWithAssertion(getEnv().APP_URL, {
      iss: clientId,
      sub: clientId,
    });
    expect(status).toBe(400);
    expect(String(json.error)).toBe("invalid_target");
  });

  it("lets an operator-provisioned client name the platform audience in its assertion", async () => {
    await ensureCliClient();
    const { status, json } = await tokenWithAssertion(getEnv().APP_URL, {
      iss: APPSTRATE_CLI_CLIENT_ID,
      sub: APPSTRATE_CLI_CLIENT_ID,
    });
    // Past this gate: the provider answers on the unverifiable assertion.
    expect([400, 401]).toContain(status);
    expect(String(json.error ?? "")).not.toBe("invalid_target");
  });
});

describe("CIMD refresh keeps the platform stamp", () => {
  // A CIMD refresh rewrites the client row from the re-fetched document, so the
  // platform's own discriminators have to be re-asserted on every one —
  // `onClientRefreshed` is what does that. This suite drives a real
  // registration, a real refresh and a real mint.
  //
  // The org this suite binds its tokens to is real: `oauth_resources` sits
  // outside `truncateAll`, and the mcp module's periodic reconcile deletes
  // per-org rows whose org is absent from `organizations` — which would take
  // this suite's audience row with it.

  let documentOctet = 100;
  let clientId: string;
  let redirectUri: string;
  let orgUri: string;
  let fetchDocument: ReturnType<typeof spyOn<typeof cimdTransport, "fetchClientMetadataResource">>;

  /** Full authorization-code + PKCE exchange, returning the decoded access token. */
  async function mintAccessToken(cookie: string): Promise<Record<string, unknown>> {
    const { claims } = await authorizationCodeFlow({
      cookie,
      clientId,
      redirectUri,
      scope: "openid profile email",
      resource: orgUri,
    });
    return claims;
  }

  async function storedClient() {
    const [row] = await db
      .select({ level: oauthClient.level, selfService: oauthClient.selfService })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId));
    if (!row) throw new Error("CIMD client was not persisted");
    return row;
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // A distinct address per test: the document cache is keyed on client_id and
    // outlives `truncateAll()`.
    documentOctet += 1;
    clientId = `https://93.184.216.${documentOctet}/client.json`;
    redirectUri = `https://93.184.216.${documentOctet}/callback`;
    const { id: ownerId } = await createTestUser();
    const { org } = await createTestOrg(ownerId, { slug: "cimd-refresh" });
    orgUri = getMcpOrgResourceUri(org.id);
    fetchDocument = spyOn(cimdTransport, "fetchClientMetadataResource").mockImplementation(
      async () =>
        Response.json({
          client_id: clientId,
          client_name: "Client that names its own level",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
    );
    registerMcpOrgFamily();
    await db
      .insert(oauthResource)
      .values({ id: crypto.randomUUID(), identifier: orgUri, name: "MCP endpoint (cimd suite)" })
      .onConflictDoNothing({ target: oauthResource.identifier });
  });

  afterEach(async () => {
    fetchDocument.mockRestore();
    await db.delete(oauthResource).where(eq(oauthResource.identifier, orgUri));
  });

  // The plugin instances (and the CIMD document cache inside them) are rebuilt
  // here, so restore the harness's own build for the rest of the run.
  afterAll(() => {
    _rebuildAuthForTesting();
  });

  it("keeps the columns, the audience cage and the claim shape across a refresh", async () => {
    const cookie = await signUpPlatformUser("cimd-level@satellite.example.com");

    const first = await mintAccessToken(cookie);
    expect(first.actor_type).toBe("user");
    expect(first.org_id).toBeUndefined();
    expect((await storedClient()).selfService).toBe(true);

    // Clear the stamp, so the refresh has something to restore. Without
    // `onClientRefreshed` the row stays cleared and the audience cage lifts.
    await db
      .update(oauthClient)
      .set({ selfService: false })
      .where(eq(oauthClient.clientId, clientId));

    // Dropping the plugin instances drops the in-process document cache, so the
    // next resolution re-fetches and takes the provider's UPDATE branch — a real
    // refresh.
    _rebuildAuthForTesting();
    const second = await mintAccessToken(cookie);
    expect(fetchDocument.mock.calls.length).toBeGreaterThan(1);

    const stored = await storedClient();
    expect(stored.level).toBe("instance");
    expect(stored.selfService).toBe(true);
    expect(second.actor_type).toBe("user");
    expect(second.org_id).toBeUndefined();
  });

  it("still refuses the platform audience after a refresh", async () => {
    await signUpPlatformUser("cimd-cage@satellite.example.com");
    // Register the client (first document resolution), then refresh it.
    await app.request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid",
        state: "cage",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    );
    _rebuildAuthForTesting();
    await app.request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid",
        state: "cage",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    );

    const token = await app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "irrelevant-code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: "a".repeat(43),
        resource: getEnv().APP_URL,
      }).toString(),
    });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_target" });
  });
});

describe("CIMD client_id URL policy gate", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
  });

  it("refuses a client_id on the run network's Docker alias before fetching it", async () => {
    // `sidecar` is an ordinary name to upstream's public-routability check — it
    // is only a name that resolves anywhere inside a run network. The platform
    // denylist runs as `isMetadataDocumentUrlAllowed`, BEFORE the document is
    // fetched, so nothing leaves the process.
    const fetchDocument = spyOn(cimdTransport, "fetchClientMetadataResource");
    const clientId = "https://sidecar/client.json";
    const res = await app.request(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://sidecar/callback",
        scope: "openid",
        state: "denylist",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    );
    // Refused, and never sent anywhere near the login page. The gate throws
    // `invalid_client` during client resolution, so authorize answers in place
    // (400, no Location) instead of redirecting.
    const location = res.headers.get("location");
    if (location === null) {
      expect(res.status).toBe(400);
    } else {
      expect(new URL(location, "http://localhost").pathname).not.toBe("/api/oauth/login");
    }
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId))).toEqual(
      [],
    );
    fetchDocument.mockRestore();
  });
});
