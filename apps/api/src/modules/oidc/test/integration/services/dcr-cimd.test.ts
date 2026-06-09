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
 * The CIMD fetch/validation path itself is owned + tested by @better-auth/cimd
 * upstream; here we assert our wiring advertises it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
import {
  getMcpOrgResourceUri,
  orgIdFromMcpAudience,
  addMcpOrgAudience,
  _resetMcpOrgAudiencesForTesting,
} from "../../../../mcp/audiences.ts";
import { getEnv } from "@appstrate/env";
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

describe("Dynamic Client Registration (RFC 7591)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
  });

  it("registers a public client unauthenticated with identity scopes", async () => {
    // Identity scopes are always in the self-service set. Module scopes
    // (mcp:read/mcp:invoke) are added in production via the module-permission
    // provider (`getModuleEndUserAllowedScopes()`), which boot wires before the
    // auth instance builds — the test harness doesn't aggregate module
    // permissions, so they aren't asserted here.
    const { status, json } = await register({
      client_name: "Claude Code (test)",
      redirect_uris: ["http://localhost:9911/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    });
    expect([200, 201]).toContain(status);
    expect(typeof json.client_id).toBe("string");
    // Public client (PKCE) — registered with no client authentication method.
    expect(json.token_endpoint_auth_method ?? "none").toBe("none");
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
    // dispatch surface. ALSO add this org to the AS `validAudiences` allowlist
    // so the library's own `checkResource` accepts the per-org URI — both gates
    // must pass for a mint.
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
    _resetMcpOrgAudiencesForTesting();
    addMcpOrgAudience(ORG_ID);
  });

  afterEach(() => {
    // Drop the org audience so the mutable allowlist does not leak into other
    // suites sharing the process.
    _resetMcpOrgAudiencesForTesting();
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
    // The resource gate passes for the per-org MCP audience (registered family +
    // added to validAudiences); the request still fails downstream on the bogus
    // code — but NOT with our `invalid_target`.
    expect(String(json.error ?? "")).not.toBe("invalid_target");
    if (status === 400) expect(String(json.error)).not.toBe("invalid_target");
  });
});
