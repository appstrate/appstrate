// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the `/api/mcp` HTTP surface through the real platform
 * middleware chain: public RFC 9728 discovery, the unauthenticated 401, the
 * authenticated Streamable-HTTP handshake, a full tools/list → tools/call →
 * invoke_operation round-trip (proving in-process dispatch), and RBAC denial.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { auditEvents } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll, db } from "../../../../../test/helpers/db.ts";
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

  it("rejects unauthenticated /api/mcp with 401 + RFC 9728 WWW-Authenticate challenge", async () => {
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).not.toBeNull();
    expect(challenge!).toContain("Bearer");
    // Points at the path-insertion PRM variant so the client can discover the
    // AS. Anchored on the canonical APP_URL base (NOT the request origin) so
    // audience binding stays correct behind a reverse proxy — see
    // `mcp/router.ts` / `mcp/resource.ts`.
    const appBase = getEnv().APP_URL.replace(/\/+$/, "");
    expect(challenge!).toContain(
      `resource_metadata="${appBase}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect(challenge!).toContain('scope="mcp:read mcp:invoke"');
    // No token presented → not a step-up, so no insufficient_scope error.
    expect(challenge!).not.toContain("insufficient_scope");
  });

  it("403s an authenticated caller lacking mcp:read with an insufficient_scope step-up challenge", async () => {
    const headers = await apiKeyHeaders(["agents:read"]);
    const res = await app.request("/api/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).not.toBeNull();
    expect(challenge!).toContain('error="insufficient_scope"');
    expect(challenge!).toContain('scope="mcp:read mcp:invoke"');
    expect(challenge!).toContain("resource_metadata=");
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

  it("cannot escalate past the caller's REST permissions (defence in depth)", async () => {
    // THE central security promise: an `mcp:invoke` token can call
    // invoke_operation, but the DISPATCHED operation still enforces its OWN
    // permission. A key scoped to mcp:* ONLY (effective perms = the intersection
    // of requested scopes ∩ role, so it carries no api-keys:read) must NOT be
    // able to read api keys through MCP — the underlying route returns 403, and
    // the MCP layer does not bypass it. Without this, MCP would be a privilege-
    // escalation hole; with it, MCP can never exceed what the credential could
    // do over REST.
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      // listApiKeys (GET /api/api-keys) requires api-keys:read — a permission
      // this mcp-only key does not hold.
      params: { name: "invoke_operation", arguments: { operation_id: "listApiKeys" } },
    });
    const payload = toolPayload(envelope);
    // The dispatch HAPPENED (mcp:invoke present) but the op denied it: the tool
    // result carries the route's own 403, not a bypass and not a 200.
    expect(payload.data.status).toBe(403);
    expect(payload.isError).toBe(true);
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

describe("mcp audit + rate limiting", () => {
  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
  });

  it("records an mcp.operation.invoked audit row for a successful invoke", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const op = [...getCatalog().operations.values()].find(
      (o) => o.method === "GET" && o.pathParams.length === 0,
    )!;
    await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    // Audit inserts are flushed before the response returns, so the row exists.
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "mcp.operation.invoked"),
          eq(auditEvents.resourceId, op.operationId),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.resourceType).toBe("mcp_operation");
    expect(rows[0]!.actorType).toBe("api_key");
    expect((rows[0]!.after as Record<string, unknown>).outcome).toBe("invoked");
  });

  it("records an mcp.operation.denied audit row when the caller lacks mcp:invoke", async () => {
    const headers = await apiKeyHeaders(["mcp:read"]);
    const op = [...getCatalog().operations.values()][0]!;
    await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "mcp.operation.denied"));
    expect(rows.length).toBe(1);
    expect((rows[0]!.after as Record<string, unknown>).outcome).toBe("denied");
  });

  it("does NOT audit read-only search/describe calls", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_operations", arguments: { query: "agent" } },
    });
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "mcp_operation"));
    expect(rows.length).toBe(0);
  });

  it("emits IETF RateLimit headers and rejects bursts beyond the limit with 429", async () => {
    // One fixed identity (same API key) so every request keys to the same
    // rate-limit bucket. The limit is 120/min; fire enough to trip it.
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    } as const;

    const first = await app.request("/api/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(init),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit")).toContain("limit=120");

    let sawRateLimit = false;
    for (let i = 0; i < 125 && !sawRateLimit; i++) {
      const res = await app.request("/api/mcp", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
        body: JSON.stringify(init),
      });
      if (res.status === 429) {
        sawRateLimit = true;
        expect(res.headers.get("Retry-After")).not.toBeNull();
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
