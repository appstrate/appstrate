// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the per-org `/api/mcp/o/:org` HTTP surface through the
 * real platform middleware chain: public RFC 9728 discovery, the
 * unauthenticated 401, the authenticated Streamable-HTTP handshake, a full
 * tools/list → tools/call → invoke_operation round-trip (proving in-process
 * dispatch), and RBAC denial.
 *
 * Every caller carries an org (API key → its org; session → X-Org-Id), so each
 * request is routed to THAT org's endpoint `/api/mcp/o/<orgId>` — the path the
 * org guard requires to match the resolved org.
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

/** The per-org MCP endpoint for an org id (`X-Org-Id` header carries the same). */
function mcpPath(headers: Record<string, string>): string {
  return `/api/mcp/o/${headers["X-Org-Id"]}`;
}

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** POST a JSON-RPC message to the caller's per-org endpoint, parse the envelope. */
async function rpc(
  headers: Record<string, string>,
  message: Record<string, unknown>,
): Promise<{ status: number; envelope: JsonRpcEnvelope }> {
  const res = await app.request(mcpPath(headers), {
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

  it("serves per-org RFC 9728 metadata at the path-inserted well-known URL", async () => {
    // A fixed org id — the well-known is public, so no auth is needed and the
    // org need not exist for the metadata document to be served (the `resource`
    // is derived purely from the path).
    const orgId = "00000000-0000-0000-0000-0000000000ab";
    const res = await app.request(`/.well-known/oauth-protected-resource/api/mcp/o/${orgId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.resource as string).endsWith(`/api/mcp/o/${orgId}`)).toBe(true);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    // Must be the AS *issuer identifier* (`APP_URL/api/auth`), not the bare
    // origin — otherwise RFC 8414 §3.3 issuer matching fails and strict OAuth
    // clients (the claude.ai connector) reject discovery. See router.ts.
    expect((body.authorization_servers as string[])[0]?.endsWith("/api/auth")).toBe(true);
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:invoke"]);
  });

  it("advertises an authorization_servers entry that byte-matches the live AS issuer (RFC 8414 §3.3)", async () => {
    // Cross-document contract: the `authorization_servers` entry in the
    // protected-resource metadata is an AS *issuer identifier*. A strict client
    // (the claude.ai connector) discovers the AS metadata from it and rejects
    // the handshake unless the `issuer` it reads back is byte-identical
    // (RFC 8414 §3.3). The two surfaces were previously verified in isolation —
    // the AS issuer was `${APP_URL}/api/auth`, the PRM advertised the bare
    // origin, and nothing asserted they matched, so the mismatch shipped.
    //
    // Derive the discovery URL exactly as a strict RFC 8414 client does — by
    // inserting the issuer's path component after `.well-known` — rather than
    // fetching the origin-root form. Fetching the root form here would mask a
    // path-insertion gap: the advertised issuer carries a `/api/auth` path, so
    // a real client requests `/.well-known/oauth-authorization-server/api/auth`,
    // NOT the bare root. (That gap shipped once: the root form returned JSON, the
    // path-inserted form fell through to the SPA `/*` catch-all and returned
    // `index.html`, so the connector's `JSON.parse` failed on the leading `<`.)
    const orgId = "00000000-0000-0000-0000-0000000000ae";
    const prmRes = await app.request(`/.well-known/oauth-protected-resource/api/mcp/o/${orgId}`);
    expect(prmRes.status).toBe(200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    const advertisedAs = prm.authorization_servers[0]!;
    expect(typeof advertisedAs).toBe("string");

    // RFC 8414 §3.1 path-insertion: `https://host/path` → `https://host/.well-known/oauth-authorization-server/path`.
    const issuerPath = new URL(advertisedAs).pathname.replace(/\/$/, "");
    const discoveryUrl = `/.well-known/oauth-authorization-server${issuerPath}`;
    const asRes = await app.request(discoveryUrl);
    // The derived URL MUST resolve to the metadata document — not a 404 and not
    // the SPA shell. A non-JSON body here is exactly the failure that broke the
    // Claude MCP connector.
    expect(asRes.status).toBe(200);
    expect(asRes.headers.get("content-type") ?? "").toContain("json");
    const asMeta = (await asRes.json()) as { issuer: string };
    expect(typeof asMeta.issuer).toBe("string");

    // Byte-match against the issuer served at the client-derived URL (RFC 8414 §3.3).
    expect(advertisedAs).toBe(asMeta.issuer);
  });

  it("rejects an unauthenticated per-org endpoint with 401 + RFC 9728 WWW-Authenticate challenge", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000ac";
    const res = await app.request(`/api/mcp/o/${orgId}`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).not.toBeNull();
    expect(challenge!).toContain("Bearer");
    // Points at the per-org path-insertion PRM variant for the REQUESTED org so
    // the client discovers the AS and requests a token bound to THIS org.
    // Anchored on the canonical APP_URL base (NOT the request origin) so audience
    // binding stays correct behind a reverse proxy — see `mcp/router.ts`.
    const appBase = getEnv().APP_URL.replace(/\/+$/, "");
    expect(challenge!).toContain(
      `resource_metadata="${appBase}/.well-known/oauth-protected-resource/api/mcp/o/${orgId}"`,
    );
    expect(challenge!).toContain('scope="mcp:read mcp:invoke"');
    // No token presented → not a step-up, so no insufficient_scope error.
    expect(challenge!).not.toContain("insufficient_scope");
  });

  it("403s an authenticated caller lacking mcp:read with an insufficient_scope step-up challenge", async () => {
    const headers = await apiKeyHeaders(["agents:read"]);
    const res = await app.request(mcpPath(headers), {
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

  it("rejects GET on the per-org endpoint with 405 for an authenticated caller", async () => {
    // Stateless transport (no session id, JSON response mode) does not serve a
    // standalone SSE stream, so GET is Method Not Allowed. This is the
    // behaviour the OpenAPI spec documents; assert it rather than trust it.
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const res = await app.request(mcpPath(headers), {
      method: "GET",
      headers: { ...headers, Accept: MCP_ACCEPT },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("rejects DELETE on the per-org endpoint with 405 (no session to terminate in stateless mode)", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const res = await app.request(mcpPath(headers), { method: "DELETE", headers });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("rejects an unauthenticated GET on a per-org endpoint with 401 (auth runs before the transport)", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000ad";
    const res = await app.request(`/api/mcp/o/${orgId}`, {
      method: "GET",
      headers: { Accept: MCP_ACCEPT },
    });
    expect(res.status).toBe(401);
  });

  it("403s a caller whose resolved org does not match the URL's org (url-vs-org guard)", async () => {
    // An API key is bound to its own org; pointing it at a DIFFERENT org's
    // endpoint must not silently act on the key's org — the router rejects the
    // URL/identity mismatch. (For Bearer callers the audience check rejects
    // earlier; this guard is the authoritative one for key/session callers.)
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const otherOrgId = "00000000-0000-0000-0000-0000000000ae";
    const res = await app.request(`/api/mcp/o/${otherOrgId}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });
});

describe("mcp tool round-trip", () => {
  beforeEach(async () => {
    await truncateAll();
    resetCatalog();
  });

  it("lists the available tools with annotations after initialize", async () => {
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
    expect(names.sort()).toEqual([
      "describe_operation",
      "get_me",
      "invoke_operation",
      "list_documents",
      "run_and_wait",
      "search_operations",
    ]);
    const runAndWait = tools.find((t) => t.name === "run_and_wait")!;
    expect((runAndWait.annotations as Record<string, unknown>).destructiveHint).toBe(true);
    const getMe = tools.find((t) => t.name === "get_me")!;
    expect((getMe.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
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
    // The integration preference order (connected > activated > inactive) is the
    // single source of truth here — both chat engines and external MCP clients
    // read it from these instructions, so the chat prompt no longer restates it.
    expect(instructions).toContain("Integration preference");
    // The generated operation index is appended under this exact heading; the
    // chat splits on the same literal to strip it for uncached/no-tool
    // providers (see applyOperationIndexPolicy in module-chat). Keep in sync.
    expect(instructions).toContain("## Operation index");
    // ...and the index actually lists operations under it (compact form:
    // comma-separated operationIds per tag, no per-op summary).
    const indexSection = instructions!.split("## Operation index")[1]!;
    expect(indexSection).toContain("listAgents");
    // Regression guard for the compact index (TTFT): operationIds only, never the
    // old `- operationId — summary` form. The bullet+em-dash would re-bloat the
    // index (~3.4k tokens) that every uncached turn re-sends. If summaries return,
    // this fails — re-evaluate the token cost first.
    expect(indexSection).not.toContain(" — ");
    expect(indexSection).not.toMatch(/^- \w/m);
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

    const first = await app.request(mcpPath(headers), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(init),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit")).toContain("limit=120");

    let sawRateLimit = false;
    for (let i = 0; i < 125 && !sawRateLimit; i++) {
      const res = await app.request(mcpPath(headers), {
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
