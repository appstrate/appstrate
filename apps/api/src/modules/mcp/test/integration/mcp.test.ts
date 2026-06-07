// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the `/mcp` HTTP surface: public RFC 9728 discovery,
 * the unauthenticated WWW-Authenticate challenge, and the authenticated
 * Streamable-HTTP handshake through the real platform middleware chain.
 *
 * Tool behaviour (search/describe/invoke + in-process dispatch) is covered
 * by the unit suite; here we prove the transport + auth gate end to end.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext, orgOnlyHeaders } from "../../../../../test/helpers/auth.ts";
import { setPlatformApp } from "../../../../lib/platform-app.ts";

const app = getTestApp();
// Wire in-process dispatch to the test app (production sets this in
// registerModuleRoutes; the test harness mounts modules inline).
setPlatformApp(app);

const MCP_ACCEPT = "application/json, text/event-stream";

describe("mcp discovery + auth gate", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("serves RFC 9728 protected-resource metadata publicly", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.resource).toBe("string");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.resource as string).endsWith("/mcp")).toBe(true);
  });

  it("rejects unauthenticated /api/mcp with 401", async () => {
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("completes the MCP initialize handshake for an authenticated caller", async () => {
    const ctx = await createTestContext();
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: {
        ...orgOnlyHeaders(ctx),
        "content-type": "application/json",
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("appstrate");
  });
});
