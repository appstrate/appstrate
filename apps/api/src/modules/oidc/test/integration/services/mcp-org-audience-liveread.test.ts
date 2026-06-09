// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for a load-bearing library contract: the AS must honour a
 * per-org MCP resource audience added to `validAudiences` AT RUNTIME.
 *
 * The org-aware allowlist (`mcp/audiences.ts`) mutates the array passed by
 * reference into the oauth-provider + oidc-guards plugins. This proves both read
 * it LIVE on `/oauth2/token`: a per-org resource is rejected before it is added
 * and accepted (past the resource gate) right after — no restart, no re-wire.
 *
 * If this ever fails after a dependency bump, `@better-auth/oauth-provider` has
 * started snapshotting `validAudiences` at plugin construction instead of
 * reading it live (see the LIBRARY CONTRACT note in `auth/plugins.ts`). Per-org
 * minting then silently breaks for every org created after boot; the fix is a
 * library patch or consent-time binding, not a code change here.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
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
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

async function register() {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code (org-audience spike)",
      redirect_uris: ["http://localhost:9931/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return String(json.client_id);
}

async function tokenWithResource(clientId: string, resource: string) {
  // The resource gate runs in the /oauth2/token before-hook, ahead of code
  // validation — a bogus code is enough to reach (and read) the gate's verdict.
  const res = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "irrelevant-code",
      client_id: clientId,
      redirect_uri: "http://localhost:9931/callback",
      code_verifier: "x".repeat(43),
      resource,
    }).toString(),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** A resource-gate rejection (either plugin). NOT a downstream grant error. */
function isResourceRejection(error: string): boolean {
  return error === "invalid_request" || error === "invalid_target" || error === "invalid_resource";
}

describe("per-org MCP audience honoured live on /oauth2/token (library contract)", () => {
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

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    _resetMcpOrgAudiencesForTesting();
    // Register the per-org resource FAMILY (mirrors the production registration
    // in `mcp/router.ts`) so the self-service resource-restriction guard (which
    // checks the protected-resource registry, not validAudiences) passes —
    // isolating the validAudiences live-read as the discriminator.
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

  it("rejects the per-org resource BEFORE it is added to validAudiences", async () => {
    const clientId = await register();
    const { json } = await tokenWithResource(clientId, orgUri);
    expect(isResourceRejection(String(json.error))).toBe(true);
  });

  it("accepts the per-org resource AFTER a runtime addMcpOrgAudience()", async () => {
    const clientId = await register();
    addMcpOrgAudience(orgId);
    const { json } = await tokenWithResource(clientId, orgUri);
    // Past the resource gate now — the call still fails on the bogus code, but
    // NOT with a resource/audience error.
    expect(isResourceRejection(String(json.error ?? ""))).toBe(false);
  });
});
