// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the `/api/mcp` HTTP surface through the real platform
 * middleware chain: public RFC 9728 discovery, the unauthenticated 401, the
 * authenticated Streamable-HTTP handshake, a full tools/list → tools/call →
 * invoke_operation round-trip (proving in-process dispatch), and RBAC denial.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext, orgOnlyHeaders } from "../../../../../test/helpers/auth.ts";
import { seedApiKey } from "../../../../../test/helpers/seed.ts";
import { setPlatformApp } from "../../../../lib/platform-app.ts";
import { getCatalog, resetCatalog } from "../../catalog.ts";

const app = getTestApp();
// Wire in-process dispatch to the test app (production sets this in
// registerModuleRoutes; the test harness mounts modules inline).
setPlatformApp(app);

const MCP_ACCEPT = "application/json, text/event-stream";

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** POST a JSON-RPC message to /api/mcp and return the parsed envelope. */
async function rpc(
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
}

/** Parse the JSON payload a tool returns in its first text content block. */
function toolPayload(envelope: JsonRpcEnvelope): {
  isError: boolean;
  data: Record<string, unknown>;
} {
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  const first = content[0];
  return {
    isError: Boolean(envelope.result?.isError),
    data: first ? (JSON.parse(first.text) as Record<string, unknown>) : {},
  };
}

async function apiKeyHeaders(scopes: string[]): Promise<Record<string, string>> {
  const ctx = await createTestContext();
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
}

describe("mcp discovery + auth gate", () => {
  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
  });

  it("serves RFC 9728 metadata at the bare and path-inserted well-known URLs", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.resource as string).endsWith("/api/mcp")).toBe(true);
      expect(Array.isArray(body.authorization_servers)).toBe(true);
      expect(body.scopes_supported).toEqual(["mcp:read", "mcp:invoke"]);
    }
  });

  it("rejects unauthenticated /api/mcp with 401", async () => {
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("403s an authenticated caller lacking mcp:read", async () => {
    const headers = await apiKeyHeaders(["agents:read"]);
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects GET on /api/mcp with 405 for an authenticated caller", async () => {
    // Stateless transport (no session id, JSON response mode) does not serve a
    // standalone SSE stream, so GET is Method Not Allowed. This is the
    // behaviour the OpenAPI spec documents; assert it rather than trust it.
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const res = await app.request("/api/mcp", {
      method: "GET",
      headers: { ...headers, Accept: MCP_ACCEPT },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("rejects DELETE on /api/mcp with 405 (no session to terminate in stateless mode)", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const res = await app.request("/api/mcp", { method: "DELETE", headers });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("rejects an unauthenticated GET on /api/mcp with 401 (auth runs before the transport)", async () => {
    const res = await app.request("/api/mcp", { method: "GET", headers: { Accept: MCP_ACCEPT } });
    expect(res.status).toBe(401);
  });
});

describe("mcp tool round-trip", () => {
  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
  });

  it("lists the three tools with annotations after initialize", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (envelope.result?.tools as Array<Record<string, unknown>>) ?? [];
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual(["describe_operation", "invoke_operation", "search_operations"]);
    const invoke = tools.find((t) => t.name === "invoke_operation")!;
    expect((invoke.annotations as Record<string, unknown>).destructiveHint).toBe(true);
    const search = tools.find((t) => t.name === "search_operations")!;
    expect((search.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
  });

  it("searches then invokes a real operation in-process", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const search = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_operations", arguments: { query: "agent", limit: 3 } },
    });
    expect((toolPayload(search.envelope).data.count as number) > 0).toBe(true);

    // Pick a real GET operation with no path params and invoke it. The
    // underlying route runs through the full pipeline, so the result carries
    // a real numeric HTTP status — proving in-process dispatch end to end.
    const op = [...getCatalog().operations.values()].find(
      (o) => o.method === "GET" && o.pathParams.length === 0,
    )!;
    const invoke = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    const payload = toolPayload(invoke.envelope);
    expect(typeof payload.data.status).toBe("number");
  });

  it("denies invoke_operation when the caller lacks mcp:invoke", async () => {
    const headers = await apiKeyHeaders(["mcp:read"]);
    const op = [...getCatalog().operations.values()][0]!;
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    expect(toolPayload(envelope).isError).toBe(true);
  });

  it("handles concurrent in-flight invoke_operation calls without cross-contamination", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    // Distinct read-only GET operations with no path params: each request gets
    // its own server+transport+tool context (router is stateless), so firing
    // them concurrently must not bleed state between requests.
    const ops = [...getCatalog().operations.values()]
      .filter((o) => o.method === "GET" && o.pathParams.length === 0)
      .slice(0, 8);
    expect(ops.length).toBeGreaterThan(1);

    const results = await Promise.all(
      ops.map((op, i) =>
        rpc(headers, {
          jsonrpc: "2.0",
          id: 100 + i,
          method: "tools/call",
          params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
        }),
      ),
    );

    // Every call resolved to a well-formed tool result with a numeric status,
    // and each JSON-RPC response id matches its request id (no swapped envelopes).
    results.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect((res.envelope as { id?: number }).id ?? 100 + i).toBe(100 + i);
      const payload = toolPayload(res.envelope);
      expect(typeof payload.data.status).toBe("number");
    });
  });

  it("completes the initialize handshake for a session caller", async () => {
    const ctx = await createTestContext();
    const { status, envelope } = await rpc(orgOnlyHeaders(ctx), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(status).toBe(200);
    expect((envelope.result?.serverInfo as { name?: string })?.name).toBe("appstrate");
    // Onboarding instructions are returned so the client can inject them into
    // the system prompt before the model sees any tool schema.
    const instructions = envelope.result?.instructions as string | undefined;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("Appstrate");
    expect(instructions).toContain("@appstrate");
  });
});
