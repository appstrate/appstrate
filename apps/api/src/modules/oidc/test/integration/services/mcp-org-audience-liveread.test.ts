// SPDX-License-Identifier: Apache-2.0

/**
 * The RFC 8707 resource gate on the token/authorize endpoints, and the one
 * property that must never regress: a per-org MCP resource created AT RUNTIME
 * is mintable immediately — no restart, no re-wire.
 *
 * The mechanism is the persisted resource model (`@better-auth/oauth-provider`
 * ≥ 1.7.3): the AS resolves every requested `resource` against `oauth_resources`
 * PER REQUEST, so a row inserted while the process runs (what the mcp module
 * does on `onOrgCreate`) is honoured on the very next call — and, because the
 * table is shared, on every other replica too. This file drives that table
 * directly rather than the mcp module so the resource lookup is the only
 * discriminator.
 *
 * If the "after" case ever fails, the plugin has started caching resource rows
 * that were not opted into `cachedResources` (see the note on that option in
 * `auth/plugins.ts`): per-org minting then silently breaks for every org created
 * after boot.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { oauthResource } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import {
  registerProtectedResourceFamily,
  resetProtectedResources,
  snapshotProtectedResources,
  restoreProtectedResources,
} from "../../../../../lib/protected-resources.ts";
import { getMcpOrgResourceUri, orgIdFromMcpAudience } from "../../../../../lib/audiences.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });
const REDIRECT_URI = "http://localhost:9931/callback";

async function register() {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code (org-audience spike)",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
      // A loopback http callback is only registrable by a NATIVE client (OIDC
      // Dynamic Registration §2) — which is what an MCP client on a loopback
      // port is. A `web` client would be refused `invalid_redirect_uri`.
      application_type: "native",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return String(json.client_id);
}

/**
 * `/oauth2/authorize` resolves the requested resource BEFORE it looks for a
 * session, so an anonymous GET is enough to read the resource gate's verdict:
 * a rejected resource redirects to `redirect_uri?error=…`, an accepted one
 * carries on to the login page. Returns both halves — a caller asserting the
 * accepted case must name the destination, or a 500 with no `Location` would
 * read as "got past the gate".
 */
async function authorizeFor(clientId: string, resource?: string) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile",
    state: "s",
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
  });
  if (resource) query.set("resource", resource);
  const res = await app.request(`/api/auth/oauth2/authorize?${query.toString()}`);
  const location = res.headers.get("location");
  if (!location) return { status: res.status };
  const target = new URL(location, REDIRECT_URI);
  return {
    status: res.status,
    pathname: target.pathname,
    error: target.searchParams.get("error") ?? undefined,
  };
}

/** POST `/oauth2/token`. The guard runs in the before-hook, ahead of the grant. */
async function tokenErrorFor(clientId: string, resource?: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: "irrelevant-code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: "x".repeat(43),
  });
  if (resource) body.set("resource", resource);
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: json.error };
}

describe("RFC 8707 resource gate on the AS", () => {
  const orgId = "00000000-0000-0000-0000-0000000000aa";
  const orgUri = getMcpOrgResourceUri(orgId);

  // The protected-resource registry is a process-wide singleton shared with the
  // live app. Snapshot before this file replaces the family and restore after,
  // so a later test file's MCP registration is not clobbered (order-safe).
  let resourceSnapshot: ReturnType<typeof snapshotProtectedResources>;
  beforeAll(() => {
    resourceSnapshot = snapshotProtectedResources();
  });
  afterAll(() => {
    restoreProtectedResources(resourceSnapshot);
  });

  // `oauth_resources` is deliberately outside `truncateAll` (see
  // `oidc/test/tables.ts`), so this file owns its own row lifecycle.
  const dropOrgResource = () =>
    db.delete(oauthResource).where(eq(oauthResource.identifier, orgUri));

  beforeEach(async () => {
    await truncateAll();
    await dropOrgResource();
    await flushRedis();
    resetOidcGuardsLimiters();
    // Register the per-org resource FAMILY (mirrors the production registration
    // in `mcp/router.ts`) so the self-service resource-restriction guard (which
    // checks the protected-resource registry, not the resource table) passes —
    // isolating the `oauth_resources` lookup as the discriminator.
    resetProtectedResources();
    registerProtectedResourceFamily({
      prefix: "/api/mcp/o",
      deriveUri: (path) => {
        const id = path.slice("/api/mcp/o/".length).split("/")[0];
        return id ? getMcpOrgResourceUri(id) : undefined;
      },
      ownsUri: (uri) => orgIdFromMcpAudience(uri) !== undefined,
    });
  });

  afterEach(async () => {
    await dropOrgResource();
  });

  it("rejects the per-org resource with invalid_target BEFORE its row exists", async () => {
    const clientId = await register();
    expect((await authorizeFor(clientId, orgUri)).error).toBe("invalid_target");
  });

  it("accepts the per-org resource AFTER its row is inserted at runtime", async () => {
    const clientId = await register();
    expect((await authorizeFor(clientId, orgUri)).error).toBe("invalid_target");
    await db
      .insert(oauthResource)
      .values({
        id: crypto.randomUUID(),
        identifier: orgUri,
        name: `MCP endpoint for organization ${orgId}`,
      })
      .onConflictDoNothing({ target: oauthResource.identifier });
    // Past the resource gate now — the request carries on to the login page.
    // Naming the destination is what separates it from a 500.
    expect(await authorizeFor(clientId, orgUri)).toMatchObject({
      pathname: "/api/oauth/login",
      error: undefined,
    });
  });

  it("rejects a resource whose row is disabled", async () => {
    const clientId = await register();
    await db
      .insert(oauthResource)
      .values({
        id: crypto.randomUUID(),
        identifier: orgUri,
        name: "disabled org endpoint",
        disabled: true,
      })
      .onConflictDoNothing({ target: oauthResource.identifier });
    expect((await authorizeFor(clientId, orgUri)).error).toBe("invalid_target");
  });

  it("rejects a token request carrying NO resource (our guard, not the library)", async () => {
    // Upstream tolerates a missing `resource` — it just mints an unbound token.
    // Ours must not: an opaque, audience-less access token is unverifiable by
    // the platform Bearer strategy, which would 401 every later request with no
    // hint. The rejection is `invalid_request`, distinct from `invalid_target`.
    const clientId = await register();
    const { status, error } = await tokenErrorFor(clientId);
    expect(status).toBe(400);
    expect(error).toBe("invalid_request");
  });

  it("rejects a token request for a resource that was never registered", async () => {
    // A self-service client may bind a token to one registered protected
    // resource and nothing else, so an arbitrary identifier is `invalid_target`
    // at the guard, before the AS ever resolves it against `oauth_resources`.
    const clientId = await register();
    const { status, error } = await tokenErrorFor(clientId, "https://evil.example.com");
    expect(status).toBe(400);
    expect(error).toBe("invalid_target");
  });
});
