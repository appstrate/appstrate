// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 resource-server audience binding via the generic
 * `enforceResourceAudience` middleware + protected-resource registry, for the
 * PER-ORG MCP resource family (`/api/mcp/o/:org`, one canonical URI per org).
 *
 * Exercised over a throwaway Hono app: a stub middleware seeds `authExtra`
 * exactly as the OIDC strategy would (it surfaces the token's `aud` as
 * `tokenAudiences`), proving both halves of the enforcement decision in
 * isolation — INBOUND (a per-org resource path requires THAT org's URI in the
 * audience, so a token for org B is rejected on org A's path) and OUTBOUND (a
 * resource-bound token may not be replayed on other routes, except for the
 * in-process self-dispatch). The "a real minted token carries the right aud"
 * half is covered in the oidc oauth-flows + dcr-cimd suites.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../../types/index.ts";
import { errorHandler } from "../../../../middleware/error-handler.ts";
import {
  enforceResourceAudience,
  registerProtectedResourceFamily,
  resetProtectedResources,
} from "../../../../lib/protected-resources.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { getMcpOrgResourceUri, orgIdFromMcpAudience } from "../../audiences.ts";

// A fixed org id and its canonical per-org MCP resource URI. The MCP server is
// exposed per organization, so the protected resource is a FAMILY under
// `/api/mcp/o` whose concrete URI is derived per request from the org segment.
const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const ORG_PATH = `/api/mcp/o/${ORG_ID}`;
const mcpUri = getMcpOrgResourceUri(ORG_ID);

/**
 * Register the per-org family exactly as `mcp/router.ts` does: derive a request
 * path's canonical org URI, and recognise a URI as owned iff it parses back to
 * an org id. Centralised so both describe blocks register identically.
 */
function registerOrgFamily(): void {
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

function app() {
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  // Stub the auth resolution: a header carries the JSON-encoded audiences so
  // each request can simulate a different token. Absence = cookie/API-key
  // caller (no token audience).
  a.use("*", async (c, next) => {
    const raw = c.req.header("x-test-aud");
    if (raw !== undefined) c.set("authExtra", { tokenAudiences: JSON.parse(raw) });
    // Mark a "user" so the guard does not early-return (mirrors the pipeline
    // gate that only runs the guard for authenticated callers).
    c.set("user", { id: "u_test", email: "t@e", name: "t" });
    return next();
  });
  a.use("*", enforceResourceAudience());
  a.all("*", (c) => c.json({ ok: true }));
  return a;
}

function req(path: string, aud?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (aud !== undefined) h["x-test-aud"] = JSON.stringify(aud);
  return app().request(`http://localhost${path}`, { headers: h });
}

describe("enforceResourceAudience — inbound (RFC 8707)", () => {
  beforeEach(() => {
    resetProtectedResources();
    registerOrgFamily();
  });

  it("allows a caller with no token audience (cookie / API key — first-party)", async () => {
    expect((await req(ORG_PATH)).status).toBe(200);
  });

  it("allows a token whose aud includes the per-org resource URI", async () => {
    expect((await req(ORG_PATH, [mcpUri])).status).toBe(200);
  });

  it("allows when the per-org resource URI is one of several audiences", async () => {
    expect((await req(ORG_PATH, ["https://other.example", mcpUri])).status).toBe(200);
  });

  it("rejects a token bound to a different resource with 401", async () => {
    expect((await req(ORG_PATH, ["https://other.example"])).status).toBe(401);
  });

  it("rejects a token bound to ANOTHER org's MCP resource with 401", async () => {
    // The core per-org confinement: org B's token presented on org A's path is
    // an audience mismatch — the family derives A's URI from the path, which is
    // absent from the token's (B-only) audience.
    const otherOrgUri = getMcpOrgResourceUri("00000000-0000-0000-0000-0000000000b2");
    expect((await req(ORG_PATH, [otherOrgUri])).status).toBe(401);
  });

  it("rejects a token with an empty audience array with 401", async () => {
    expect((await req(ORG_PATH, [])).status).toBe(401);
  });

  it("matches sub-paths of the per-org resource", async () => {
    expect((await req(`${ORG_PATH}/anything`, [mcpUri])).status).toBe(200);
    expect((await req(`${ORG_PATH}/anything`, ["https://other.example"])).status).toBe(401);
  });
});

describe("enforceResourceAudience — outbound confinement", () => {
  beforeEach(() => {
    resetProtectedResources();
    registerOrgFamily();
  });

  it("rejects a resource-bound token replayed on a NON-resource route (401)", async () => {
    // The leak this closes: an MCP token lifted to a normal REST route.
    expect((await req("/api/agents", [mcpUri])).status).toBe(401);
  });

  it("allows a first-party (no-audience) caller on a non-resource route", async () => {
    expect((await req("/api/agents")).status).toBe(200);
  });

  it("allows a non-resource-bound token on a non-resource route", async () => {
    // A token whose audience is some other (non-registered) value is not
    // confined by this guard — it is not bound to any protected resource.
    expect((await req("/api/agents", ["https://other.example"])).status).toBe(200);
  });

  it("allows a resource-bound token on a non-resource route WHEN it carries the internal-dispatch marker", async () => {
    const [name, value] = internalDispatchHeader();
    expect((await req("/api/agents", [mcpUri], { [name]: value })).status).toBe(200);
  });

  it("rejects a resource-bound token bearing a FORGED internal-dispatch marker", async () => {
    const [name] = internalDispatchHeader();
    expect((await req("/api/agents", [mcpUri], { [name]: "not-the-secret" })).status).toBe(401);
  });
});

describe("enforceResourceAudience — empty registry", () => {
  beforeEach(() => resetProtectedResources());

  it("is a pass-through when no resource is registered", async () => {
    expect((await req(ORG_PATH, [mcpUri])).status).toBe(200);
    expect((await req("/api/agents", [mcpUri])).status).toBe(200);
  });
});
