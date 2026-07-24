// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the audit/telemetry `observe` sink emitted by the three
 * tools. The tool layer is transport-agnostic — it emits plain `McpToolEvent`
 * data; here we assert exactly which events fire for each outcome, without any
 * HTTP/audit plumbing. The router maps these events to telemetry + audit
 * (covered by the integration suite).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { getCatalog, resetCatalog, type CatalogOperation } from "../../catalog.ts";
import { buildMcpTools, type Dispatch, type McpToolEvent } from "../../tools.ts";

const noExtra = {} as unknown as AppstrateRequestExtra;

function firstOp(predicate: (op: CatalogOperation) => boolean): CatalogOperation {
  const op = [...getCatalog().operations.values()].find(predicate);
  if (!op) throw new Error("no matching operation in catalog");
  return op;
}

function makeTools(permissions: string[], status = 200) {
  const events: McpToolEvent[] = [];
  const dispatch: Dispatch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const tools = buildMcpTools({
    origin: "https://test.local",
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(permissions),
    dispatch,
    observe: (e) => events.push(e),
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", applicationId: "app_1" },
  });
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));
  return { byName, events };
}

describe("observe — search_operations", () => {
  beforeEach(() => resetCatalog());

  it("emits a search event carrying the result count and a duration", async () => {
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("search_operations")!.handler({ query: "agent", limit: 3 }, noExtra);
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.tool).toBe("search_operations");
    expect(typeof e.resultCount).toBe("number");
    expect(e.resultCount).toBeLessThanOrEqual(3);
    expect(typeof e.durationMs).toBe("number");
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a zero result count for a no-match query (search hit-rate signal)", async () => {
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("search_operations")!.handler({ query: "zzznotarealthing_xyzzy" }, noExtra);
    expect(events[0]!.resultCount).toBe(0);
  });
});

describe("observe — describe_operation", () => {
  beforeEach(() => resetCatalog());

  it("emits a describe event for a known operation", async () => {
    const op = firstOp(() => true);
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("describe_operation")!.handler({ operation_id: op.operationId }, noExtra);
    expect(events.length).toBe(1);
    expect(events[0]!.tool).toBe("describe_operation");
    expect(events[0]!.operationId).toBe(op.operationId);
  });

  it("does not emit when the operationId is unknown (protocol error, thrown)", async () => {
    const { byName, events } = makeTools(["mcp:read"]);
    // Unknown operationId is now a thrown -32602 InvalidParams protocol
    // error; telemetry still must NOT record a describe event for it.
    await expect(
      byName.get("describe_operation")!.handler({ operation_id: "nope" }, noExtra),
    ).rejects.toThrow("Unknown operationId");
    expect(events.length).toBe(0);
  });
});

describe("observe — invoke_operation", () => {
  beforeEach(() => resetCatalog());

  it("emits outcome=invoked with method/path/status after dispatch", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, events } = makeTools(["mcp:read", "mcp:invoke"], 200);
    await byName.get("invoke_operation")!.handler({ operation_id: op.operationId }, noExtra);
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.tool).toBe("invoke_operation");
    expect(e.outcome).toBe("invoked");
    expect(e.operationId).toBe(op.operationId);
    expect(e.method).toBe("GET");
    expect(e.path).toBe(op.pathTemplate);
    expect(e.status).toBe(200);
  });

  it("records the underlying HTTP status even on an error response", async () => {
    const op = firstOp((o) => o.method === "GET" && o.pathParams.length === 0);
    const { byName, events } = makeTools(["mcp:read", "mcp:invoke"], 503);
    await byName.get("invoke_operation")!.handler({ operation_id: op.operationId }, noExtra);
    expect(events[0]!.outcome).toBe("invoked");
    expect(events[0]!.status).toBe(503);
  });

  it("emits outcome=denied (no dispatch) when the caller lacks mcp:invoke", async () => {
    const op = firstOp(() => true);
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("invoke_operation")!.handler({ operation_id: op.operationId }, noExtra);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("denied");
    expect(events[0]!.status).toBeUndefined();
  });

  it("emits outcome=rejected for an unknown operationId (before the protocol error throws)", async () => {
    const { byName, events } = makeTools(["mcp:read", "mcp:invoke"]);
    await expect(
      byName.get("invoke_operation")!.handler({ operation_id: "doesNotExist" }, noExtra),
    ).rejects.toThrow("Unknown operationId");
    expect(events[0]!.outcome).toBe("rejected");
  });

  it("emits outcome=rejected when required path params are missing", async () => {
    const op = firstOp((o) => o.pathParams.length > 0);
    const { byName, events } = makeTools(["mcp:read", "mcp:invoke"]);
    await byName.get("invoke_operation")!.handler({ operation_id: op.operationId }, noExtra);
    expect(events[0]!.outcome).toBe("rejected");
    expect(events[0]!.operationId).toBe(op.operationId);
  });
});
