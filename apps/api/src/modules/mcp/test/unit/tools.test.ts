// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP catalog + the three progressive-disclosure tools.
 * Pure logic — no DB. Dispatch is injected so we can assert exactly what
 * request the platform would receive without booting the full app.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import {
  getCatalog,
  resetCatalog,
  buildOperationIndex,
  type CatalogOperation,
} from "../../catalog.ts";
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
      // The per-org transport endpoint (`/api/mcp/o/:org`) must never be
      // surfaced as an invokable operation — recursive self-invocation.
      expect(op.pathTemplate.startsWith("/api/mcp")).toBe(false);
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

  it("embeds the top match's full schema as best_match on a keyword search", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName.get("search_operations")!.handler({ query: "agent" }, noExtra);
    const body = parseResult(res);
    const best = body.best_match as Record<string, unknown> | undefined;
    expect(best).toBeDefined();
    // best_match is the FULL describe payload, not the compact list row.
    const ops = body.operations as Array<Record<string, unknown>>;
    expect(best!.operation_id).toBe(ops[0]!.operation_id);
    expect(typeof best!.method).toBe("string");
    expect(typeof best!.path).toBe("string");
    expect("request_body" in best!).toBe(true);
    expect("referenced_schemas" in best!).toBe(true);
  });

  it("omits best_match when there is no query (plain catalog listing)", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const res = await byName.get("search_operations")!.handler({ limit: 5 }, noExtra);
    const body = parseResult(res);
    expect(body.best_match).toBeUndefined();
  });

  it("best_match is identical to what describe_operation returns for that id", async () => {
    const { byName } = makeTools(["mcp:read"]);
    const searchRes = await byName.get("search_operations")!.handler({ query: "agent" }, noExtra);
    const best = parseResult(searchRes).best_match as Record<string, unknown>;
    const describeRes = await byName
      .get("describe_operation")!
      .handler({ operation_id: best.operation_id }, noExtra);
    expect(parseResult(describeRes)).toEqual(best);
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

  it("throws InvalidParams (-32602) on an unknown operationId — protocol error, not tool error", async () => {
    const { byName } = makeTools(["mcp:read"]);
    let caught: unknown;
    try {
      await byName.get("describe_operation")!.handler({ operation_id: "doesNotExist" }, noExtra);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((caught as McpError).message).toContain("doesNotExist");
  });

  it("throws InvalidParams (-32602) when operation_id is missing", async () => {
    const { byName } = makeTools(["mcp:read"]);
    let caught: unknown;
    try {
      await byName.get("describe_operation")!.handler({}, noExtra);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
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
    // Deliberately an `isError` TOOL result, not a protocol error: which
    // path params an operation needs is per-operation knowledge the model
    // recovers via describe_operation — keep the failure model-visible.
    const op = firstOp((o) => o.pathParams.length > 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    const res = await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId }, noExtra);
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("throws InvalidParams (-32602) when operation_id is missing — protocol error", async () => {
    const { byName, calls } = makeTools(["mcp:invoke"]);
    let caught: unknown;
    try {
      await byName.get("invoke_operation")!.handler({}, noExtra);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    expect(calls.length).toBe(0);
  });

  it("throws InvalidParams (-32602) on an unknown operationId — protocol error", async () => {
    const { byName, calls } = makeTools(["mcp:invoke"]);
    let caught: unknown;
    try {
      await byName
        .get("invoke_operation")!
        .handler({ operation_id: "doesNotExistAnywhere" }, noExtra);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((caught as McpError).message).toContain("doesNotExistAnywhere");
    expect(calls.length).toBe(0);
  });

  it("serializes the JSON body and sets content-type on a write operation", async () => {
    // The entire mutation request-shaping branch (sendBody + JSON.stringify +
    // content-type) is exercised only on POST/PUT/PATCH — assert it directly.
    const op = firstOp((o) => o.method === "POST" && o.pathParams.length === 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId, body: { hello: "world" } }, noExtra);
    const req = calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe(JSON.stringify({ hello: "world" }));
  });

  it("never sends a body on a GET operation even when one is supplied", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, calls } = makeTools(["mcp:invoke"]);
    await byName
      .get("invoke_operation")!
      .handler({ operation_id: op.operationId, body: { ignored: true } }, noExtra);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.headers.get("content-type")).toBeNull();
    expect(await req.text()).toBe("");
  });
});

describe("buildOperationIndex", () => {
  beforeEach(() => resetCatalog());

  it("lists every catalog operationId, grouped under tag headers", () => {
    const index = buildOperationIndex();
    const { operations } = getCatalog();
    // A tag section header is present.
    expect(index).toMatch(/^## /m);
    // Every operationId appears in a tag's comma-separated id line.
    for (const op of operations.values()) {
      expect(index).toContain(op.operationId);
    }
  });

  it("carries no structured method+path columns (those come from describe / best_match)", () => {
    const index = buildOperationIndex();
    const { operations } = getCatalog();
    const knownIds = new Set([...operations.values()].map((op) => op.operationId));
    // Each tag section is `## Tag` followed by ONE comma-separated line of
    // operationIds; the index must not reproduce the describe/list row shape
    // (a METHOD followed by a path). Method words can still appear inside
    // free-text summaries, so we match the structured `METHOD /path` form.
    expect(index).not.toMatch(/(GET|POST|PUT|PATCH|DELETE) \//);
    for (const line of index.split("\n")) {
      if (line === "" || line.startsWith("## ")) continue;
      // A non-header line is purely a list of known operationIds — no paths.
      for (const id of line.split(", ")) {
        expect(knownIds.has(id)).toBe(true);
      }
    }
  });

  it("is memoized — same string instance across calls", () => {
    const a = buildOperationIndex();
    const b = buildOperationIndex();
    expect(b).toBe(a);
  });
});

describe("buildMcpTools contextInjected", () => {
  beforeEach(() => resetCatalog());

  it("exposes get_me by default (external MCP clients have no injected context)", () => {
    const { byName } = makeTools(["mcp:read"]);
    expect(byName.has("get_me")).toBe(true);
  });

  it("drops get_me when the caller already injected its context, keeping the rest", () => {
    const dispatch: Dispatch = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const tools = buildMcpTools({
      origin: "https://test.local",
      authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
      permissions: new Set(["mcp:read"]),
      dispatch,
      contextInjected: true,
    });
    const names = tools.map((t) => t.descriptor.name).sort();
    // get_me is redundant for a context-injected caller; search_operations stays
    // (its best_match schema is not covered by the injected operation index).
    expect(names).toEqual([
      "describe_operation",
      "invoke_operation",
      "list_documents",
      "run_and_wait",
      "search_operations",
    ]);
  });
});
