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
 * metadata response, ensuring our self-service stamp reaches that request.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import * as cimdTransport from "@better-auth/cimd/node";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
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
    expect(JSON.parse(stored.metadata!)).toMatchObject({
      level: "instance",
      clientId,
      selfService: true,
    });
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
    // BLOCKER regression: before this fix the registered client had no
    // `metadata.level`, so `customAccessTokenClaims → buildClaimsForClient`
    // threw "missing level — cannot issue token" on EVERY token exchange, and
    // no test minted a token to catch it. Assert the row is now stamped
    // `level: "instance"` + `selfService: true` so the instance claim builder
    // runs instead of throwing.
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
      .select({ level: oauthClient.level, metadata: oauthClient.metadata })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.level).toBe("instance");
    const metadata = JSON.parse(row!.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.level).toBe("instance");
    expect(metadata.selfService).toBe(true);
  });
});

describe("self-service token audience restriction (RFC 8707 / RFC 9728)", () => {
  // A fixed org whose per-org MCP resource the self-service client may target.
  const ORG_ID = "00000000-0000-0000-0000-0000000000c1";

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // The MCP server registers the per-org family in production at module init;
    // register it directly so the token-endpoint guard
    // (`enforceSelfServiceResourceRestriction` → `isProtectedResourceUri`) has a
    // protected resource to compare against without loading the full mcp
    // dispatch surface. This suite asserts only that guard: it stops at the
    // before-hook verdict, so the org needs no `oauth_resources` row.
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
});
