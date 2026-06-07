// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 resource-server audience binding on /api/mcp (`requireMcpAudience`).
 *
 * Exercised over a throwaway Hono app: a stub middleware seeds `authExtra`
 * exactly as the OIDC strategy would (it surfaces the token's `aud` as
 * `tokenAudiences`), proving the enforcement decision in isolation. The
 * end-to-end "a real minted token carries the right aud" half is covered in
 * the oidc module's oauth-flows + dcr-cimd suites.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../../../types/index.ts";
import { errorHandler } from "../../../../middleware/error-handler.ts";
import { requireMcpAudience } from "../../router.ts";
import { getMcpResourceUri } from "../../resource.ts";

function appWithAuthExtra(authExtra: Record<string, unknown> | undefined) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    if (authExtra) c.set("authExtra", authExtra);
    return next();
  });
  app.use("*", requireMcpAudience);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("requireMcpAudience (RFC 8707)", () => {
  const mcpUri = getMcpResourceUri();

  it("allows a caller with no token audience (cookie / API key — first-party)", async () => {
    const res = await appWithAuthExtra(undefined).request("http://localhost/api/mcp");
    expect(res.status).toBe(200);
  });

  it("allows a token whose aud includes the MCP resource URI", async () => {
    const res = await appWithAuthExtra({ tokenAudiences: [mcpUri] }).request(
      "http://localhost/api/mcp",
    );
    expect(res.status).toBe(200);
  });

  it("allows when the MCP URI is one of several audiences", async () => {
    const res = await appWithAuthExtra({
      tokenAudiences: ["http://localhost:3000", mcpUri],
    }).request("http://localhost/api/mcp");
    expect(res.status).toBe(200);
  });

  it("rejects a token bound to a different resource with 401", async () => {
    const res = await appWithAuthExtra({
      tokenAudiences: ["http://localhost:3000"],
    }).request("http://localhost/api/mcp");
    expect(res.status).toBe(401);
  });

  it("rejects a token with an empty audience array with 401", async () => {
    const res = await appWithAuthExtra({ tokenAudiences: [] }).request("http://localhost/api/mcp");
    expect(res.status).toBe(401);
  });
});
