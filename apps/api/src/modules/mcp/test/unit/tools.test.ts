// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP catalog + the three progressive-disclosure tools.
 * Pure logic — no DB. Dispatch is injected so we can assert exactly what
 * request the platform would receive without booting the full app.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { getCatalog, resetCatalog, type CatalogOperation } from "../../catalog.ts";
import { buildMcpTools, type Dispatch } from "../../tools.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";

// The handlers ignore `extra`; supply a typed placeholder.
const noExtra = {} as unknown as AppstrateRequestExtra;

function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function makeTools(permissions: string[]) {
  const calls: Request[] = [];
  const dispatch: Dispatch = async (req) => {
    calls.push(req);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const tools = buildMcpTools({
    origin: "https://test.local",
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(permissions),
    dispatch,
  });
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));
  return { byName, calls };
}

function firstOp(predicate: (op: CatalogOperation) => boolean): CatalogOperation {
  const op = [...getCatalog().operations.values()].find(predicate);
  if (!op) throw new Error("no matching operation in catalog");
  return op;
}

describe("mcp catalog", () => {
  beforeEach(() => resetCatalog());

  it("indexes core operations from the live spec", () => {
    const { operations } = getCatalog();
    expect(operations.size).toBeGreaterThan(50);
  });

  it("excludes the MCP server's own transport + discovery paths", () => {
    for (const op of getCatalog().operations.values()) {
      expect(op.pathTemplate).not.toBe("/api/mcp");
      expect(op.pathTemplate.startsWith("/.well-known/oauth-protected-resource")).toBe(false);
    }
  });
});

describe("search_operations", () => {
  beforeEach(() => resetCatalog());

  it("returns keyword matches with method/path/summary", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName.get("search_operations")!.handler({ query: "agent" }, noExtra);
    const body = parseResult(res);
    expect(body.count as number).toBeGreaterThan(0);
    const ops = body.operations as Array<Record<string, unknown>>;
    expect(typeof ops[0]!.operation_id).toBe("string");
    expect(typeof ops[0]!.method).toBe("string");
  });

  it("caps results at the requested limit", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName.get("search_operations")!.handler({ limit: 3 }, noExtra);
    const body = parseResult(res);
    expect((body.operations as unknown[]).length).toBeLessThanOrEqual(3);
  });
});

describe("describe_operation", () => {
  beforeEach(() => resetCatalog());

  it("returns the operation definition", async () => {
    const op = firstOp(() => true);
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName
      .get("describe_operation")!
      .handler({ operation_id: op.operationId }, noExtra);
    const body = parseResult(res);
    expect(body.method).toBe(op.method);
    expect(body.path).toBe(op.pathTemplate);
  });

  it("errors on an unknown operationId", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName
      .get("describe_operation")!
      .handler({ operation_id: "doesNotExist" }, noExtra);
    expect(res.isError).toBe(true);
  });
});

describe("invoke_operation", () => {
  beforeEach(() => resetCatalog());

  it("dispatches a GET operation in-process and forwards auth headers", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, calls } = makeTools(["mcp:read", "mcp:invoke"]);
    const res = await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId }, noExtra);
    const body = parseResult(res);
    expect(body.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("GET");
    expect(new URL(calls[0]!.url).pathname).toBe(op.pathTemplate);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
    expect(calls[0]!.headers.get("x-org-id")).toBe("org_1");
  });

  it("interpolates path params", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length > 0);
    const values: Record<string, string> = {};
    for (const name of op.pathParams) values[name] = `v_${name}`;
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId, path_params: values }, noExtra);
    const pathname = new URL(calls[0]!.url).pathname;
    for (const name of op.pathParams) expect(pathname).toContain(`v_${name}`);
    expect(pathname).not.toContain("{");
  });

  it("preserves the @ scope sigil instead of percent-encoding it", async () => {
    const op = firstOp((o) => o.pathParams.includes("scope"));
    const values: Record<string, string> = {};
    for (const name of op.pathParams) values[name] = name === "scope" ? "@appstrate" : "demo";
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId, path_params: values }, noExtra);
    const pathname = new URL(calls[0]!.url).pathname;
    expect(pathname).toContain("@appstrate");
    expect(pathname).not.toContain("%40");
  });

  it("preserves a literal / inside a scoped-id path param", async () => {
    // Integrations key off a single {packageId} param whose value is @scope/name.
    const op = firstOp((o) => o.pathParams.length === 1 && o.pathParams[0] === "packageId");
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler(
        { operation_id: op.operationId, path_params: { packageId: "@appstrate/firecrawl" } },
        noExtra,
      );
    const pathname = new URL(calls[0]!.url).pathname;
    expect(pathname).toContain("@appstrate/firecrawl");
    expect(pathname).not.toContain("%2F");
    expect(pathname).not.toContain("%40");
  });

  it("auto-maps a declared header param supplied in query onto a real header", async () => {
    const op = firstOp((o) => o.headerParams.includes("X-Integration-Id"));
    const values: Record<string, string> = {};
    for (const name of op.pathParams) values[name] = "x";
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName.get("invoke_operation")!.handler(
      {
        operation_id: op.operationId,
        path_params: values,
        query: { "X-Integration-Id": "int_1" },
      },
      noExtra,
    );
    const req = calls[0]!;
    expect(req.headers.get("X-Integration-Id")).toBe("int_1");
    // Promoted out of the query string, not duplicated there.
    expect(new URL(req.url).searchParams.has("X-Integration-Id")).toBe(false);
  });

  it("stamps the internal-dispatch marker so re-entry bypasses outbound audience confinement", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName.get("invoke_operation")!.handler({ operation_id: op.operationId }, noExtra);
    // The exact header name/value is owned by lib/internal-dispatch; assert the
    // dispatched request carries it (its presence is what the resource-audience
    // guard checks to exempt in-process re-entry).
    const [name, value] = internalDispatchHeader();
    expect(calls[0]!.headers.get(name)).toBe(value);
  });

  it("drops a client-supplied internal-dispatch marker (forgery defence)", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const [name] = internalDispatchHeader();
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId, headers: { [name]: "forged-by-client" } }, noExtra);
    // The forged value is stripped (protected header) and replaced with the
    // authoritative per-process secret — never the client's string.
    const [, real] = internalDispatchHeader();
    expect(calls[0]!.headers.get(name)).toBe(real);
  });

  it("rejects a path param containing traversal segments (route-binding integrity)", async () => {
    // `..` would let path_params smuggle structure and re-route to a different
    // operation than the audited operationId. Must be refused before dispatch.
    const op = firstOp((o) => o.pathParams.length === 1 && o.pathParams[0] !== "scope");
    const { byName, calls } = makeTools(["mcp:invoke"]);
    const res = await byName
      .get("invoke_operation")!
      .handler(
        { operation_id: op.operationId, path_params: { [op.pathParams[0]!]: "../api-keys" } },
        noExtra,
      );
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("rejects a path param injecting an extra slash on a non-scoped param", async () => {
    const op = firstOp(
      (o) =>
        o.pathParams.length === 1 && o.pathParams[0] !== "scope" && o.pathParams[0] !== "packageId",
    );
    const { byName, calls } = makeTools(["mcp:invoke"]);
    const res = await byName
      .get("invoke_operation")!
      .handler(
        { operation_id: op.operationId, path_params: { [op.pathParams[0]!]: "x/runs" } },
        noExtra,
      );
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("forwards extra headers but never overrides forwarded auth headers", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName.get("invoke_operation")!.handler(
      {
        operation_id: op.operationId,
        headers: { "X-Target-Header": "abc", authorization: "Bearer HIJACK", "X-Org-Id": "evil" },
      },
      noExtra,
    );
    const sent = calls[0]!.headers;
    expect(sent.get("x-target-header")).toBe("abc");
    // Auth context stays as forwarded — the model cannot reshape it.
    expect(sent.get("authorization")).toBe("Bearer tok");
    expect(sent.get("x-org-id")).toBe("org_1");
  });

  it("denies invocation without mcp:invoke", async () => {
    const op = firstOp(() => true);
    const { byName, calls } = makeTools(["mcp:read"]);
    const res = await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId }, noExtra);
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("errors when required path params are missing", async () => {
    const op = firstOp((o) => o.pathParams.length > 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    const res = await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId }, noExtra);
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});
