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
import type { Actor } from "@appstrate/connect";
import {
  getCatalog,
  resetCatalog,
  buildOperationIndex,
  type CatalogOperation,
} from "../../catalog.ts";
import { buildMcpTools, RETIRED_MCP_TOOL_NAMES, type Dispatch } from "../../tools.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { validateManifest } from "@appstrate/core/validation";

// The handlers ignore `extra`; supply a typed placeholder.
const noExtra = {} as unknown as AppstrateRequestExtra;

function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function makeTools(
  permissions: string[],
  contextInjected = false,
  actor: Actor = { type: "user", id: "user_1" },
) {
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
    actor,
    scope: { orgId: "org_1", applicationId: "app_1" },
    contextInjected,
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

describe("retired pre-#1177 tool names", () => {
  beforeEach(() => resetCatalog());

  /**
   * The server advertises `tools: { listChanged: false }` — a client is
   * entitled to cache the tool list for the life of its session, so one that
   * listed before an upgrade will call `list_documents` after it and get
   * `-32602 Unknown tool` mid-conversation. The aliases stay HIDDEN because the
   * point of #1177 is the model's view of the tool surface.
   */
  it("registers every retired name, and never lists one", () => {
    const tools = buildMcpTools({
      origin: "https://test.local",
      authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
      permissions: new Set(["mcp:read", "mcp:invoke", "agents:write"]),
      dispatch: async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      actor: { type: "user", id: "user_1" },
      scope: { orgId: "org_1", applicationId: "app_1" },
    });
    const listed = new Set(tools.filter((t) => !t.hidden).map((t) => t.descriptor.name));
    const registered = new Set(tools.map((t) => t.descriptor.name));

    for (const [retired, canonical] of Object.entries(RETIRED_MCP_TOOL_NAMES)) {
      expect(registered.has(retired)).toBe(true);
      expect(listed.has(retired)).toBe(false);
      // Every alias points at a tool that is actually offered.
      expect(listed.has(canonical)).toBe(true);
    }
  });

  it("forwards a retired name to the canonical handler", async () => {
    const { byName, calls } = makeTools(["mcp:read"]);
    await byName.get("list_documents")!.handler({}, noExtra);
    await byName.get("list_files")!.handler({}, noExtra);
    // `dispatch` is a stub that echoes a constant for every request, so
    // comparing the two RESULTS proves nothing — an alias wired to the wrong
    // canonical tool would compare equal. Assert the request each one actually
    // dispatched instead.
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/files");
    expect(calls[0]!.url).toBe(calls[1]!.url);
    expect(calls[0]!.method).toBe(calls[1]!.method);
  });

  it("renames the retired document_uri argument on the way in", async () => {
    const { byName } = makeTools(["mcp:read", "mcp:invoke", "agents:write"]);
    // `validate_package_file` reads `file_uri`; a caller pinned to the old
    // vocabulary sends `document_uri`. Without the rename the tool answers
    // "file_uri is required" for an argument the caller did supply.
    // Reaching the URI-PARSE failure is the whole signal: it can only happen
    // once the argument has been renamed (`file_x` is too short for FILE_ID_RE,
    // so the parse rejects before any DB lookup — this stays a pure unit test).
    await expect(
      byName
        .get("validate_package_document")!
        .handler({ document_uri: "appfile://file_x" }, noExtra),
    ).rejects.toThrow(/Not a file URI/);
    // Negative control: the canonical tool gets no rename, so the very same
    // arguments stop at the "required" guard before any lookup happens. If this
    // stopped holding, the assertion above would no longer distinguish a working
    // rename from a missing one.
    await expect(
      byName.get("validate_package_file")!.handler({ document_uri: "appfile://file_x" }, noExtra),
    ).rejects.toThrow(/file_uri is required/);
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

  it.each(["runInline", "runAgent"])(
    "keeps the full %s operation available to context-injected chat",
    async (operationId) => {
      const { byName } = makeTools(["mcp:read"], true);
      const res = await byName
        .get("describe_operation")!
        .handler({ operation_id: operationId }, noExtra);
      const body = parseResult(res);

      expect(body.operation_id).toBe(operationId);
      expect(body).toHaveProperty("request_body");
      expect(body).toHaveProperty("referenced_schemas");
    },
  );

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
      actor: { type: "user", id: "user_1" },
      scope: { orgId: "org_1", applicationId: "app_1" },
    });
    // Only the ADVERTISED surface — the retired pre-#1177 aliases are hidden
    // (`hidden: true`), so `tools/list` never shows them. Covered separately by
    // "keeps the retired pre-#1177 tool names callable but unlisted".
    const names = tools
      .filter((t) => !t.hidden)
      .map((t) => t.descriptor.name)
      .sort();
    // get_me is redundant for a context-injected caller; search_operations stays
    // (its best_match schema is not covered by the injected operation index).
    expect(names).toEqual([
      "describe_operation",
      "get_runtime_capabilities",
      "invoke_operation",
      "list_files",
      "read_file",
      "run_and_wait",
      "search_operations",
      "validate_package_file",
    ]);
  });

  it("exposes package import only to authorized organization users", () => {
    expect(makeTools(["mcp:read", "mcp:invoke"]).byName.has("import_package_file")).toBe(false);
    expect(
      makeTools(["mcp:read", "mcp:invoke", "agents:write"]).byName.has("import_package_file"),
    ).toBe(true);
    expect(
      makeTools(["mcp:read", "mcp:invoke", "agents:write"], false, {
        type: "end_user",
        id: "eu_1",
      }).byName.has("import_package_file"),
    ).toBe(false);
  });

  it("exposes the runtime registry used by package authoring and adapters", async () => {
    const { byName } = makeTools(["mcp:read"], true);
    const result = await byName.get("get_runtime_capabilities")!.handler({}, noExtra);
    const payload = parseResult(result);
    expect(payload).toMatchObject({
      archive_required: true,
      entry_point_must_exist: true,
      package_archive_max_bytes: 10 * 1024 * 1024,
      runtimes: [
        { runtime: "node", manifest_version: "0.3", server_type: "node" },
        {
          runtime: "bun",
          manifest_version: "0.3",
          server_type: "node",
          manifest_template: {
            manifest_version: "0.3",
            schema_version: "0.1",
            type: "mcp-server",
            server: {
              type: "node",
              entry_point: "<archive-relative-entry-point>",
              mcp_config: {
                command: "bun",
                args: ["<archive-relative-entry-point>"],
              },
            },
            _meta: { "dev.appstrate/mcp-server": { runtime: "bun" } },
          },
        },
        { runtime: "python", manifest_version: "0.3", server_type: "python" },
        { runtime: "uv", manifest_version: "0.4", server_type: "uv" },
        { runtime: "binary", manifest_version: "0.3", server_type: "binary" },
      ],
    });

    const runtimes = payload.runtimes as Array<Record<string, unknown>>;
    expect(runtimes.map((entry) => entry.runtime)).toEqual([
      "node",
      "bun",
      "python",
      "uv",
      "binary",
    ]);
    for (const runtime of runtimes) {
      const entryPoint = runtime.runtime === "bun" ? "server.ts" : "server.js";
      const template = structuredClone(runtime.manifest_template) as Record<string, unknown>;
      template.name = "@test/authored-server";
      template.display_name = "Authored server";
      const server = template.server as {
        entry_point: string;
        mcp_config: { command: string; args: string[] };
      };
      server.entry_point = entryPoint;
      if (server.mcp_config.command === "<archive-relative-entry-point>") {
        server.mcp_config.command = entryPoint;
      }
      server.mcp_config.args = server.mcp_config.args.map((arg) =>
        arg === "<archive-relative-entry-point>" ? entryPoint : arg,
      );
      expect(validateManifest(template)).toMatchObject({ valid: true, errors: [] });
    }
  });
});
