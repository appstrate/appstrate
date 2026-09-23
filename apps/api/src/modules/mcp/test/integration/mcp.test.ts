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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as jose from "jose";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { auditEvents, endUsers, oidcEndUserProfiles } from "@appstrate/db/schema";
import { prefixedId } from "@appstrate/db/ids";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll, db } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
  orgOnlyHeaders,
} from "../../../../../test/helpers/auth.ts";
import {
  seedApiKey,
  seedPackage,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../../../../test/helpers/seed.ts";
import {
  MCP_ACCEPT,
  mcpPath,
  mcpRpc,
  type JsonRpcEnvelope,
} from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { drainAudits, pendingAuditCount } from "../../../../services/audit.ts";
import { getCatalog } from "../../catalog.ts";
import { createMcpRouter } from "../../router.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const rpc = mcpRpc(app);

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
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
}

describe("mcp discovery + auth gate", () => {
  beforeEach(async () => {
    await truncateAll();
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
    // Cross-file contract: the `authorization_servers` entry in the
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

  it("403s a guest with no space row and serves the same caller once a row exists", async () => {
    // RBAC spec §7.3: the per-org endpoint pins an org, resolves the ORG'S
    // DEFAULT SPACE, and reads the caller's role there. `mcp` is a space-level
    // resource, so a `guest` — implicit in no space — cannot pass its guard.
    // A session caller is used because it takes the same `resolveMcpSpaceRow` →
    // `applySpacePermissions` path a per-org bearer does; only the credential
    // that resolved the org role differs.
    const owner = await createTestContext();
    const guest = await createTestUser();
    await addOrgMember(owner.orgId, guest.id, "guest");
    const headers = { Cookie: guest.cookie, "X-Org-Id": owner.orgId };

    const denied = await app.request(mcpPath(headers), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(403);

    // The control: one `operator` row in the default space, same caller, same
    // request — and now the tool list is served.
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: guest.id,
      presetRole: "operator",
    });
    const listed = await rpc(headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    expect((listed.envelope.result?.tools as unknown[]).length).toBeGreaterThan(0);
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
  });

  it("lists the available tools with annotations after initialize", async () => {
    // Every tool this list names has a grant of its own now: `run_and_wait`
    // needs launch + run-read, `list_files` needs `GET /api/files`. Scoping the
    // key to `mcp:*` alone would drop both and this would assert on the
    // declaration gate instead of on the advertised surface.
    const headers = await apiKeyHeaders([
      "mcp:read",
      "mcp:invoke",
      "agents:run",
      "runs:read",
      "files:read",
    ]);
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
      "get_runtime_capabilities",
      "invoke_operation",
      "list_files",
      "read_file",
      "run_and_wait",
      "search_operations",
      "validate_package_file",
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

  it("narrows the advertised surface to the caller's space role", async () => {
    // The per-org endpoint resolves the org's default space and reads the
    // caller's role there (RBAC spec §7.3), and the two presets differ exactly
    // where this matters: `viewer` holds neither `agents:run` nor the mcp
    // module's `invoke` contribution, `builder` holds both. Same user shape,
    // same request — only the space row's preset differs.
    const owner = await createTestContext();

    const listFor = async (presetRole: "viewer" | "builder"): Promise<string[]> => {
      const member = await createTestUser();
      await addOrgMember(owner.orgId, member.id, "member");
      await seedSpaceMember({ spaceId: owner.defaultSpaceId, userId: member.id, presetRole });
      const headers = { Cookie: member.cookie, "X-Org-Id": owner.orgId };
      const { envelope } = await rpc(headers, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      return (envelope.result?.tools as Array<{ name: string }>).map((t) => t.name);
    };

    const viewer = await listFor("viewer");
    expect(viewer).not.toContain("run_and_wait");
    expect(viewer).not.toContain("invoke_operation");
    // A viewer DOES hold `files:read` and `mcp:read`: this is a narrowing of
    // the surface, not an empty list — without that control the case above
    // would also pass if the whole list were gone.
    expect(viewer).toContain("list_files");
    expect(viewer).toContain("search_operations");

    const builder = await listFor("builder");
    expect(builder).toContain("run_and_wait");
    expect(builder).toContain("invoke_operation");
  });

  it("searches then invokes a real operation in-process", async () => {
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const search = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_operations", arguments: { query: "agent", limit: 3 } },
    });
    expect((toolPayload(search.envelope).data.total as number) > 0).toBe(true);

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

  it("does not declare invoke_operation when the caller lacks mcp:invoke", async () => {
    const headers = await apiKeyHeaders(["mcp:read"]);
    const listed = await rpc(headers, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = (listed.envelope.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("invoke_operation");

    // And calling it anyway is refused by the SDK before any handler runs:
    // tools are registered per session, so a tool that is not declared is
    // simply not there.
    const op = [...getCatalog().operations.values()][0]!;
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    expect(envelope.error?.message).toContain("Unknown tool: invoke_operation");
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

  it("cannot share a package: `share` is on no API key, MCP or not", async () => {
    // `sharePackage` is an operation like any other, and the RBAC it meets is
    // the REST pipeline's (RBAC spec §6.10): the verb decides who runs a
    // package with whose credentials, so it is absent from the API-key
    // allowlist and a key can never carry it — through MCP no more than
    // directly.
    const ctx = await createTestContext();
    await seedPackage({
      id: "@mcpshare/worker",
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
    });
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["mcp:read", "mcp:invoke", "agents:read", "agents:write", "agents:configure"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}`, "X-Org-Id": ctx.orgId };
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: {
          operation_id: "sharePackage",
          path_params: { scope: "@mcpshare", name: "worker" },
          body: { target: { kind: "space", space_id: ctx.defaultSpaceId } },
        },
      },
    });
    const payload = toolPayload(envelope);
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
    // single source of truth here — the chat engine and external MCP clients
    // read it from these instructions, so the chat prompt no longer restates it.
    expect(instructions).toContain("Integration preference");
    // Package authoring guidance also lives only at the MCP seam. The chat
    // engine appends these instructions, and external MCP clients receive the
    // same safe validate-before-import workflow.
    expect(instructions).toContain("MCP package authoring");
    expect(instructions).toContain("BOTH `valid: true` AND `importable: true`");
    expect(instructions).toContain("report them instead of attempting a doomed mutation");
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

  it("reports and enforces `listSpaceMembers` in the space its PATH names", async () => {
    // The endpoint pins ONE space (here the org default, A) but the operation
    // acts on the space in its path. `requireSpaceFromParam` re-applies the
    // caller's permissions there, so the requirement the tool reports is the
    // TARGET space's — and A's set neither grants nor withholds it.
    const owner = await createTestContext();
    const caller = await memberContext(owner, "member", "operator");
    const runs = await seedSpace({ orgId: owner.orgId, name: "Runs", visibility: "closed" });
    await seedSpaceMember({ spaceId: runs.id, userId: caller.user.id, presetRole: "admin" });
    const foreign = await seedSpace({ orgId: owner.orgId, name: "Foreign", visibility: "closed" });
    const headers = { Cookie: caller.cookie, "X-Org-Id": owner.orgId };

    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const { envelope } = await rpc(headers, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return toolPayload(envelope);
    };

    const described = await call(1, "describe_operation", { operation_id: "listSpaceMembers" });
    // The two halves are reported apart: nothing is asked in the caller's own
    // space, `space-members:read` is asked in the one the path names.
    expect(described.data.target_space_permissions).toContain("space-members:read");
    expect(described.data.required_permissions).toEqual([]);
    // `operator` in A holds no `space-members:read` anywhere in A, and the
    // operation is still offered: the caller-space set is not what decides it.
    expect(described.data.granted).toBe(true);

    const inRuns = await call(2, "invoke_operation", {
      operation_id: "listSpaceMembers",
      path_params: { id: runs.id },
    });
    expect(inRuns.data.status).toBe(200);

    // The same call one space over, where this caller has no row at all: the
    // TARGET space refuses, and the refusal is not a permission the caller
    // could acquire in A — so the result carries no permission advice.
    const inForeign = await call(3, "invoke_operation", {
      operation_id: "listSpaceMembers",
      path_params: { id: foreign.id },
    });
    expect([403, 404]).toContain(inForeign.data.status as number);
    expect(inForeign.isError).toBe(true);
    expect(inForeign.data.required_permissions).toBeUndefined();
    expect(inForeign.data.hint).toBeUndefined();

    // A target-space operation is a listed one: searching must offer it rather
    // than bury it under `denied`, which is where a caller-space reading of the
    // requirement would have put it.
    const searched = await call(4, "search_operations", { query: "members", limit: 100 });
    const listed = (searched.data.operations as Array<{ operation_id: string }>).map(
      (entry) => entry.operation_id,
    );
    const denied = (searched.data.denied as Array<{ operation_id: string }>).map(
      (entry) => entry.operation_id,
    );
    expect(listed).toContain("listSpaceMembers");
    expect(denied).not.toContain("listSpaceMembers");
  });

  it("advertises the tools a CUSTOM space role's own permission list allows", async () => {
    // A bundle is not a preset: the surface has to follow the strings the row
    // carries, not the nearest preset to them.
    const owner = await createTestContext();
    const member = await createTestUser();
    await addOrgMember(owner.orgId, member.id, "member");
    const role = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["mcp:read", "mcp:invoke", "agents:run", "runs:read-all"],
    });
    await seedSpaceMember({
      spaceId: owner.defaultSpaceId,
      userId: member.id,
      presetRole: null,
      customRoleId: role.id,
    });

    const { envelope } = await rpc(
      { Cookie: member.cookie, "X-Org-Id": owner.orgId },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    const names = (envelope.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("run_and_wait");
    expect(names).toContain("invoke_operation");
    // The control: the bundle names no `files:read`, so the file tool is gone
    // while the two above stay — a narrowing, not an empty list.
    expect(names).not.toContain("list_files");
  });
});

describe("mcp audit + rate limiting", () => {
  beforeEach(async () => {
    await truncateAll();
    // The burst assertion below counts requests against a Redis-backed limiter
    // whose keys `truncateAll()` does not touch. Without this the test silently
    // depends on every suite that ran before it having spent none of that
    // budget — it passes alone and gets a premature 429 in a full run, which is
    // exactly what happened once this branch added request-making tests
    // upstream of it. 24 other suites already flush for the same reason.
    await flushRedis();
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
    // The insert is tracked, not awaited, on the response path — drain the
    // registry (what shutdown does) before asserting on the row.
    expect((await drainAudits(5_000)).drained).toBe(true);
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

  it("audits nothing when the caller lacks mcp:invoke — the tool is never declared", async () => {
    // RBAC spec §4.3 audits a denial once, at the guard that fires it. With
    // `invoke_operation` absent from what this caller is shown, no tool ran and
    // there is nothing for the MCP layer to record; a row here would mean the
    // declaration gate is gone and the handler refuses inside the tool.
    const headers = await apiKeyHeaders(["mcp:read"]);
    const op = [...getCatalog().operations.values()][0]!;
    await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
    });
    expect((await drainAudits(5_000)).drained).toBe(true);
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "mcp_operation"));
    expect(rows.length).toBe(0);
  });

  it("returns the MCP response before the audit insert settles — the insert is tracked, not awaited", async () => {
    // The same module, with a router whose audit sink is an insert that does
    // not settle until this test says so.
    let settleInsert!: () => void;
    const insert = new Promise<void>((resolve) => {
      settleInsert = resolve;
    });
    const stubbedApp = getTestApp({
      modules: [
        { ...mcpModule, createRouter: () => createMcpRouter({ recordAudit: () => insert }) },
      ],
    });
    const headers = await apiKeyHeaders(["mcp:read", "mcp:invoke"]);
    const op = [...getCatalog().operations.values()].find(
      (o) => o.method === "GET" && o.pathParams.length === 0,
    )!;
    const pendingBefore = pendingAuditCount();

    try {
      const request = Promise.resolve(
        stubbedApp.request(mcpPath(headers), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "invoke_operation", arguments: { operation_id: op.operationId } },
          }),
        }),
      );
      // Negative control: a router that awaits the insert cannot answer while
      // it is pending — this `await` then never resolves and the test times out.
      expect((await request).status).toBe(200);

      // The insert is registered and still pending — a bounded drain reports
      // it as not drained rather than losing it.
      expect(pendingAuditCount()).toBe(pendingBefore + 1);
      expect((await drainAudits(20)).drained).toBe(false);
    } finally {
      settleInsert();
    }

    // Once the insert settles, the drain shutdown relies on completes.
    expect((await drainAudits(1_000)).drained).toBe(true);
    expect(pendingAuditCount()).toBe(pendingBefore);
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

  // What is unique to THIS layer is the WIRING: that `/api/mcp/o/:org` is
  // actually mounted behind `rateLimitMcp(MCP_RATE_LIMIT_PER_MIN)` and charges
  // the caller's API key. The limiter's own semantics — IETF headers, 429,
  // Retry-After, the identity ladder, one bucket across paths — are pinned in
  // `apps/api/test/unit/rate-limit.test.ts` against small limits.
  //
  // This used to fire 125 sequential envelopes to burn a 120/min budget down
  // to a 429. That re-proved the unit-tested behaviour at the cost of ~5s of
  // in-process HTTP, and CI timed it out. Two requests prove the wiring: the
  // advertised limit is the mounted constant, and the second request is
  // charged to the same bucket as the first.
  it("charges the mounted 120/min MCP limiter, keyed on the caller", async () => {
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
    const post = () =>
      app.request(mcpPath(headers), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
        body: JSON.stringify(init),
      });

    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit")).toContain("limit=120");
    const firstRemaining = Number(
      /remaining=(\d+)/.exec(first.headers.get("RateLimit") ?? "")?.[1],
    );
    expect(firstRemaining).toBe(119);

    // Same API key, same bucket: one more point gone. A route mounted behind a
    // per-request limiter, or keyed on something that varies per call, would
    // hand back 119 again here.
    const second = await post();
    expect(second.status).toBe(200);
    const secondRemaining = Number(
      /remaining=(\d+)/.exec(second.headers.get("RateLimit") ?? "")?.[1],
    );
    expect(secondRemaining).toBe(118);
  });
});

// ---------------------------------------------------------------------------
// The OIDC end-user principal, through the real transport. An end-user is not
// an organization member: its grants come from the token's scopes, filtered by
// the module's end-user allowlist, and its actor type closes surfaces no scope
// can open.
// ---------------------------------------------------------------------------
const END_USER_KID = "mcp-enduser-key";
let endUserSigningKey: jose.CryptoKey;

/** Seed an end-user in a fresh org and mint an access token carrying `scope`. */
async function endUserHeaders(scope: string): Promise<Record<string, string>> {
  const ctx = await createTestContext();
  const authUser = await createTestUser();
  const endUserId = prefixedId("eu");
  await db
    .insert(endUsers)
    .values({ id: endUserId, spaceId: ctx.defaultSpaceId, orgId: ctx.orgId, name: "Embedded" });
  await db
    .insert(oidcEndUserProfiles)
    .values({ endUserId, authUserId: authUser.id, emailVerified: true, status: "active" });
  const token = await new jose.SignJWT({
    sub: authUser.id,
    actor_type: "end_user",
    end_user_id: endUserId,
    space_id: ctx.defaultSpaceId,
    scope,
  })
    .setProtectedHeader({ alg: "ES256", kid: END_USER_KID })
    // The verifier matches Better Auth's own issuer/audience shape.
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    // RFC 8707: the per-org MCP resource URI must be in `aud` or the endpoint
    // refuses the token, whatever its scopes say.
    .setAudience([process.env.APP_URL!, `${process.env.APP_URL!}/api/mcp/o/${ctx.orgId}`])
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(endUserSigningKey);
  return {
    Authorization: `Bearer ${token}`,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
  };
}

describe("mcp tools/list for an OIDC end-user", () => {
  beforeAll(async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    endUserSigningKey = privateKey;
    const jwk = await jose.exportJWK(publicKey);
    // Serve this key as the JWKS: the Better Auth singleton the preload built
    // signs with a different key set, so self-minted tokens verify only here.
    overrideJwks(async () => ({ keys: [{ ...jwk, kid: END_USER_KID, alg: "ES256", use: "sig" }] }));
  });

  afterAll(() => overrideJwks(null));

  beforeEach(async () => {
    await truncateAll();
  });

  const toolNames = async (headers: Record<string, string>): Promise<string[]> => {
    const { envelope } = await rpc(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    return (envelope.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
  };

  it("offers the run and invoke tools its scopes carry, never the package import", async () => {
    const names = await toolNames(
      await endUserHeaders("openid mcp:read mcp:invoke agents:run runs:read"),
    );
    expect(names).toContain("run_and_wait");
    expect(names).toContain("invoke_operation");
    // Importing a package is closed to an end-user on both counts: no package
    // write permission is in the end-user scope allowlist, and the tool refuses
    // any actor that is not an organization user.
    expect(names).not.toContain("import_package_file");
  });

  it("drops run_and_wait when the same token cannot read back what it would launch", async () => {
    const names = await toolNames(await endUserHeaders("openid mcp:read mcp:invoke agents:run"));
    expect(names).not.toContain("run_and_wait");
    // The control: only the run pair went, so this is the `runs:read` half and
    // not a token that stopped resolving.
    expect(names).toContain("invoke_operation");
  });
});
