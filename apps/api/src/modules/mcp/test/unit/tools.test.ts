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
  getOperationIndexCacheStats,
  operationGranted,
  type CatalogOperation,
} from "../../catalog.ts";
import { buildMcpTools, type Dispatch } from "../../tools.ts";
import { internalDispatchHeader } from "../../../../lib/internal-dispatch.ts";
import { validateManifest } from "@appstrate/core/validation";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { setPlatformApp } from "../../../../lib/platform-app.ts";

// The tools now read the mounted route table (what each operation's guard
// requires) to decide what this caller is shown. Register the SHARED test app,
// as `catalog-requirements.test.ts` does: `setPlatformApp` is module-level
// state in a one-process runner, so a stand-in here would answer for every
// later file too.
setPlatformApp(getTestApp());

// The handlers ignore `extra`; supply a typed placeholder.
const noExtra = {} as unknown as AppstrateRequestExtra;

/**
 * Everything the full tool surface takes: the transport gate, invoke, launch
 * AND read-back (`run_and_wait`), and the `GET /api/files` operation
 * (`list_files`). A test that is not about the declaration gate uses this so it
 * asserts on the tool it means to, not on whether it was declared.
 */
const FULL_SURFACE = ["mcp:read", "mcp:invoke", "agents:run", "runs:read", "files:read"];

function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function makeTools(
  permissions: string[],
  contextInjected = false,
  actor: Actor = { type: "user", id: "user_1" },
  /** What the platform answers the dispatched request with. */
  respond: () => Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
) {
  const calls: Request[] = [];
  const dispatch: Dispatch = async (req) => {
    calls.push(req);
    return respond();
  };
  const tools = buildMcpTools({
    origin: "https://test.local",
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(permissions),
    dispatch,
    actor,
    scope: { orgId: "org_1", spaceId: "spc_1" },
    authorizeBundle: async () => {},
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

/**
 * What the caller is SHOWN, per permission set. An act its grants make
 * structurally impossible is absent — not declared and then refused — so every
 * case here goes red the moment its gate is dropped from `buildMcpTools`.
 */
describe("buildMcpTools declarations", () => {
  beforeEach(() => resetCatalog());

  const names = (permissions: string[]): string[] => [...makeTools(permissions).byName.keys()];

  it("shows a read-only caller neither invoke, run nor files", () => {
    const declared = names(["mcp:read"]);
    expect(declared).not.toContain("invoke_operation");
    expect(declared).not.toContain("run_and_wait");
    expect(declared).not.toContain("list_files");
    // The control: discovery is behind the transport's own gate, so it stays.
    expect(declared).toContain("search_operations");
    expect(declared).toContain("describe_operation");
  });

  it("declares invoke_operation on `mcp:invoke` alone", () => {
    expect(names(["mcp:read"])).not.toContain("invoke_operation");
    expect(names(["mcp:read", "mcp:invoke"])).toContain("invoke_operation");
  });

  it("withholds run_and_wait until the caller can launch AND read the run back", () => {
    // Both halves, on the same builder: `agents:run` without a run-read
    // permission would bill a provisioned run whose poll takes a 403.
    expect(names(["mcp:read", "mcp:invoke"])).not.toContain("run_and_wait");
    expect(names(["mcp:read", "mcp:invoke", "agents:run"])).not.toContain("run_and_wait");
    expect(names(["mcp:read", "agents:run", "runs:read-all"])).not.toContain("run_and_wait");
    expect(names(["mcp:read", "mcp:invoke", "agents:run", "runs:read-all"])).toContain(
      "run_and_wait",
    );
  });

  it('offers `kind:"inline"` only once the caller may also author', () => {
    const kinds = (permissions: string[]): string[] | undefined =>
      (
        makeTools(permissions).byName.get("run_and_wait")!.descriptor.inputSchema
          .properties as Record<string, { enum?: string[] }>
      ).kind!.enum;
    const runner = ["mcp:read", "mcp:invoke", "agents:run", "runs:read-all"];
    expect(kinds(runner)).toEqual(["agent"]);
    expect(kinds([...runner, "agents:write"])).toEqual(["agent", "inline"]);
  });

  it("declares list_files exactly when `GET /api/files` grants", () => {
    // The tool dispatches to `listFiles`, whose route is guarded by
    // `files:read`; without it the tool could only ever return a 403.
    expect(names(["mcp:read"])).not.toContain("list_files");
    expect(names(["mcp:read", "files:read"])).toContain("list_files");
  });
});

describe("pre-#1177 argument vocabulary", () => {
  beforeEach(() => resetCatalog());

  it("does not rename a retired document_uri argument", async () => {
    const { byName } = makeTools(["mcp:read", "mcp:invoke", "agents:write"]);
    // `validate_package_file` reads `file_uri`. A caller pinned to the old
    // vocabulary now gets the plain "required" error rather than a silent
    // rename — the argument it sent is simply not one the tool knows.
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

  // A search is a question the model asked on purpose, so a match its role
  // cannot invoke is answered honestly rather than hidden — "no such operation"
  // would be a lie to a user asking "can you run this agent?".
  describe("denied matches", () => {
    /** A viewer-ish set: reads agents, launches nothing, authors nothing. */
    const VIEWER = ["mcp:read", "agents:read"];

    async function searchAgents(): Promise<{
      operations: Array<Record<string, unknown>>;
      denied: Array<{ operation_id: string; required_permissions: string[] }>;
      body: Record<string, unknown>;
    }> {
      const { byName } = makeTools(VIEWER);
      const res = await byName
        .get("search_operations")!
        .handler({ query: "agent", limit: 100 }, noExtra);
      const body = parseResult(res);
      return {
        operations: body.operations as Array<Record<string, unknown>>,
        denied: body.denied as Array<{ operation_id: string; required_permissions: string[] }>,
        body,
      };
    }

    it("answers a denied match under `denied`, never under `operations`", async () => {
      const { operations, denied } = await searchAgents();
      const shown = operations.map((op) => op.operation_id);
      const refused = new Map(
        denied.map((row) => [row.operation_id, row.required_permissions] as const),
      );

      // `POST /api/agents/{scope}/{name}/run` is guarded by `agents:run`, which
      // this set does not hold; `GET /api/agents` is `agents:read|agents:run`,
      // which it does.
      expect(shown).toContain("listAgents");
      expect(shown).not.toContain("runAgent");
      expect([...refused.keys()]).toContain("runAgent");
      expect(refused.get("runAgent")).toEqual(["agents:run"]);
      // `POST /api/packages/agents` is `agents:write` — same treatment.
      expect(shown).not.toContain("createAgent");
      expect(refused.get("createAgent")).toEqual(["agents:write"]);
    });

    it("counts only granted matches and never points best_match at a denied one", async () => {
      const { operations, denied, body } = await searchAgents();
      // `limit: 100` is the tool's maximum: the granted half fitting under it
      // is what makes `count === total` a statement about filtering rather
      // than about truncation.
      expect(operations.length).toBeLessThan(100);
      expect(body.count).toBe(operations.length);
      expect(body.total).toBe(operations.length);
      // The denied half is real, so `count` counting both would be caught here.
      expect(denied.length).toBeGreaterThan(0);
      // `denied` is capped at `limit`; `denied_total` is not, so the model can
      // tell "three you may not call" from "eighty".
      expect(body.denied_total as number).toBeGreaterThanOrEqual(denied.length);
      if (denied.length < 100) expect(body.denied_total).toBe(denied.length);
      const best = body.best_match as Record<string, unknown>;
      expect(best.operation_id).toBe(operations[0]!.operation_id);
      expect(best.granted).toBe(true);
      expect(denied.map((row) => row.operation_id)).not.toContain(best.operation_id);
    });
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

  // What the route's own guards ask for, and whether this caller holds it —
  // both read off the mounted guards, never a hand-kept list beside them.
  describe("permission fields", () => {
    /** Launch and read back, author nothing: the `runner` shape. */
    const RUNNER = ["mcp:read", "mcp:invoke", "agents:run", "runs:read"];

    async function describeOp(
      permissions: string[],
      operationId: string,
    ): Promise<Record<string, unknown>> {
      const { byName } = makeTools(permissions);
      return parseResult(
        await byName.get("describe_operation")!.handler({ operation_id: operationId }, noExtra),
      );
    }

    it("names both guards of a denied operation, in mount order", async () => {
      // `POST /api/runs/inline` mounts `requirePermission("agents","write")`
      // then `requirePermission("agents","run")` — a runner holds the second
      // only, so the operation stays describable and reports itself denied.
      const body = await describeOp(RUNNER, "runInline");
      expect(body.required_permissions).toEqual(["agents:write", "agents:run"]);
      expect(body.conditional).toBe(false);
      expect(body.granted).toBe(false);
    });

    it("reports a granted operation as granted for the same caller", async () => {
      // Same permission set, the other verdict: `GET /api/agents` is
      // `agents:read|agents:run` and a runner holds the alternative.
      const body = await describeOp(RUNNER, "listAgents");
      expect(body.required_permissions).toEqual(["agents:read|agents:run"]);
      expect(body.granted).toBe(true);
    });
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

  it("is not declared at all without mcp:invoke", () => {
    // Was "denies invocation without mcp:invoke": the refusal moved earlier —
    // the tool is never shown, so there is no handler to refuse with. What a
    // client that calls it anyway gets is pinned by
    // `test/integration/mcp.test.ts`.
    expect(makeTools(["mcp:read"]).byName.has("invoke_operation")).toBe(false);
  });

  it("names the permission the route refused with, and tells the model not to retry", async () => {
    // `listAgents` (GET /api/agents) is guarded by `agents:read|agents:run`,
    // which an mcp-only caller does not hold — the shape of a real 403.
    const { byName, calls } = makeTools(
      ["mcp:read", "mcp:invoke"],
      false,
      { type: "user", id: "user_1" },
      () =>
        new Response(JSON.stringify({ title: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await byName
      .get("invoke_operation")!
      .handler({ operation_id: "listAgents" }, noExtra);
    // Decision #1: the dispatch always happens — the route is the one
    // enforcement point. What the 403 adds is the reason, not a second gate.
    expect(calls.length).toBe(1);
    expect(res.isError).toBe(true);
    const body = parseResult(res);
    expect(body.status).toBe(403);
    expect(body.required_permissions).toEqual(["agents:read|agents:run"]);
    expect(body.hint).toContain("do not retry");
  });

  it("adds no permission hint to a non-403 failure", async () => {
    // The enrichment is keyed on 403 alone; a 500 must not be reported to the
    // model as a role problem it should stop retrying.
    const { byName } = makeTools(
      ["mcp:read", "mcp:invoke"],
      false,
      { type: "user", id: "user_1" },
      () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
    );
    const body = parseResult(
      await byName.get("invoke_operation")!.handler({ operation_id: "listAgents" }, noExtra),
    );
    expect(body.status).toBe(500);
    expect("hint" in body).toBe(false);
    expect("required_permissions" in body).toBe(false);
  });

  it("adds no permission hint to a 403 on an operation the caller IS granted", async () => {
    // `createAgentVersion` mounts `requirePackageInOrg()` alone — no stamped
    // requirement, so the catalog grants it and only the loaded row can
    // refuse. Telling this caller "your role does not hold this permission"
    // would be false and would send it to report a role problem it does not
    // have; the refusal is about THAT package.
    const { byName } = makeTools(
      ["mcp:read", "mcp:invoke"],
      false,
      { type: "user", id: "user_1" },
      () =>
        new Response(JSON.stringify({ title: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const body = parseResult(
      await byName.get("invoke_operation")!.handler(
        {
          operation_id: "createAgentVersion",
          path_params: { scope: "@acme", name: "writer" },
        },
        noExtra,
      ),
    );
    expect(body.status).toBe(403);
    expect("hint" in body).toBe(false);
    expect("required_permissions" in body).toBe(false);
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

  /**
   * The ids a rendered index actually lists. Substring matching would lie
   * here: `createAgent` is a substring of `createAgentVersion`, a DIFFERENT
   * operation with a different guard.
   */
  function indexIds(index: string): string[] {
    const ids: string[] = [];
    for (const line of index.split("\n")) {
      if (line === "" || line.startsWith("## ")) continue;
      ids.push(...line.split(", "));
    }
    return ids;
  }

  it("lists every operation this caller's guards grant, grouped under tag headers", () => {
    const permissions = new Set(["mcp:read", "agents:read"]);
    const index = buildOperationIndex(permissions);
    const { operations } = getCatalog();
    // A tag section header is present.
    expect(index).toMatch(/^## /m);
    const listed = indexIds(index);
    for (const op of operations.values()) {
      expect(listed.includes(op.operationId)).toBe(operationGranted(op, permissions));
    }
  });

  it("indexes the agent reads `agents:read` opens and none of the acts it does not", () => {
    const listed = indexIds(buildOperationIndex(new Set(["mcp:read", "agents:read"])));
    // Granted: `GET /api/agents` (`agents:read|agents:run`) and
    // `GET /api/packages/agents` (`agents:read`).
    expect(listed).toContain("listAgents");
    expect(listed).toContain("listAgentPackages");
    // Denied: `POST /api/packages/agents` (`agents:write`) and
    // `POST /api/agents/{scope}/{name}/run` (`agents:run`).
    expect(listed).not.toContain("createAgent");
    expect(listed).not.toContain("runAgent");
  });

  it("keeps only what no guard gates when the caller holds nothing", () => {
    const listed = indexIds(buildOperationIndex(new Set<string>()));
    // `/api/me/*` mounts no permission guard — self-scoped, filtered by
    // ownership — so the index is narrowed, never emptied.
    expect(listed).toContain("getMyContext");
    expect(listed).toContain("listMyOrgs");
    // Everything an agent guard gates is gone with it.
    expect(listed).not.toContain("listAgents");
    expect(listed).not.toContain("runAgent");
  });

  it("carries no structured method+path columns (those come from describe / best_match)", () => {
    const index = buildOperationIndex(new Set(["mcp:read", "agents:read"]));
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
    const a = buildOperationIndex(new Set(["mcp:read"]));
    const b = buildOperationIndex(new Set(["mcp:read"]));
    expect(b).toBe(a);
  });

  // The permission-scoped index is what the MCP router builds on EVERY
  // `tools/call` POST (the chat module drives each tool call through it), so
  // it is memoised per permission set. Strings compare by value under
  // `Object.is`, so identity cannot prove a memo hit — the build counter can.
  describe("permission-scoped memo", () => {
    it("serves a repeated permission set from the memo, order-independently", () => {
      const first = buildOperationIndex(new Set(["mcp:read", "agents:read"]));
      expect(getOperationIndexCacheStats()).toEqual({ entries: 1, builds: 1 });

      const second = buildOperationIndex(new Set(["agents:read", "mcp:read"]));
      expect(second).toBe(first);
      // Negative control: an unmemoised build would report `builds: 2` here.
      expect(getOperationIndexCacheStats()).toEqual({ entries: 1, builds: 1 });
    });

    it("keeps distinct permission sets apart — they yield different indexes", () => {
      const narrow = indexIds(buildOperationIndex(new Set(["mcp:read"])));
      const wide = indexIds(buildOperationIndex(new Set(["mcp:read", "agents:read"])));
      // Per operation, not per tag: a section survives on its row-conditional
      // members (`updateAgent` and friends are `requirePackageInOrg()`, which
      // only the loaded row can refuse), so the difference has to be read on a
      // concrete id — `GET /api/packages/agents` is `agents:read`.
      expect(narrow).not.toContain("listAgentPackages");
      expect(wide).toContain("listAgentPackages");
      expect(getOperationIndexCacheStats()).toEqual({ entries: 2, builds: 2 });
    });

    it("is dropped with the catalog — resetCatalog forces a rebuild", () => {
      const before = buildOperationIndex(new Set(["mcp:read"]));
      resetCatalog();
      expect(getOperationIndexCacheStats()).toEqual({ entries: 0, builds: 0 });

      const after = buildOperationIndex(new Set(["mcp:read"]));
      expect(after).toEqual(before);
      expect(getOperationIndexCacheStats()).toEqual({ entries: 1, builds: 1 });
    });

    it("is bounded — past 64 sets the oldest is evicted and rebuilt on demand", () => {
      for (let i = 0; i < 65; i++) buildOperationIndex(new Set(["mcp:read", `x:${i}`]));
      expect(getOperationIndexCacheStats()).toEqual({ entries: 64, builds: 65 });

      // The first (oldest) set was evicted, so asking for it again is a miss…
      buildOperationIndex(new Set(["mcp:read", "x:0"]));
      expect(getOperationIndexCacheStats().builds).toBe(66);
      // …while the most recent one is still a hit.
      buildOperationIndex(new Set(["mcp:read", "x:64"]));
      expect(getOperationIndexCacheStats().builds).toBe(66);
    });
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
      // The full surface, so this asserts on get_me's absence and nothing
      // else — every other tool here has a grant of its own.
      permissions: new Set(FULL_SURFACE),
      dispatch,
      contextInjected: true,
      actor: { type: "user", id: "user_1" },
      scope: { orgId: "org_1", spaceId: "spc_1" },
      authorizeBundle: async () => {},
    });
    // The whole registered surface IS the advertised surface: no retired name
    // is registered, listed or hidden — see "registers no retired name, listed
    // or hidden" above.
    const names = tools.map((t) => t.descriptor.name).sort();
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
