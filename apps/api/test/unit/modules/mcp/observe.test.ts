// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the audit/telemetry `observe` sink emitted by the three
 * tools. The tool layer is transport-agnostic — it emits plain `McpToolEvent`
 * data; here we assert exactly which events fire for each outcome, without any
 * HTTP/audit plumbing. The router maps these events to telemetry + audit
 * (covered by the integration suite).
 */

import { describe, it, expect } from "bun:test";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { getCatalog, type CatalogOperation } from "../../../../src/modules/mcp/catalog.ts";
import {
  type Dispatch,
  type McpToolContext,
  type McpToolEvent,
} from "../../../../src/modules/mcp/tools.ts";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { toolsFor } from "./helpers.ts";

// `buildMcpTools` decides what this caller is shown from the guards mounted on
// the routes, so it reads the route table.
await registerTestPlatformApp();

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
  const ctx: McpToolContext = {
    origin: "https://test.local",
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(permissions),
    ceiling: undefined,
    dispatch,
    observe: (e) => events.push(e),
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: "spc_1" },
    authorizeBundle: async () => {},
    mayShareRoot: async () => false,
    readSkill: () => Promise.reject(new Error("read_skill is not exercised here")),
    requestId: "req_test",
  };
  const tools = toolsFor(ctx);
  const byName = new Map(tools.map((t) => [t.descriptor.name, t]));
  return { byName, events };
}

describe("observe — search_operations", () => {
  it("emits a search event carrying the shown count and a duration", async () => {
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("search_operations")!.handler({ query: "agent", limit: 3 }, noExtra);
    expect(events.length).toBe(1);
    const e = events[0]!;
    expect(e.tool).toBe("search_operations");
    expect(typeof e.shownCount).toBe("number");
    expect(e.shownCount).toBeLessThanOrEqual(3);
    expect(typeof e.durationMs).toBe("number");
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    // How often a caller's role is what stood between it and a match — the
    // signal that says "this role is mis-scoped", not "the search is bad".
    // An `mcp:read`-only caller is denied `runAgent`, `createAgent` and more.
    expect(e.deniedCount).toBeGreaterThan(0);
  });

  it("reports a zero shown count for a no-match query (search hit-rate signal)", async () => {
    const { byName, events } = makeTools(["mcp:read"]);
    await byName.get("search_operations")!.handler({ query: "zzznotarealthing_xyzzy" }, noExtra);
    expect(events[0]!.shownCount).toBe(0);
    // Nothing matched, so nothing was denied either — the two counters move
    // independently.
    expect(events[0]!.deniedCount).toBe(0);
  });
});

describe("observe — describe_operation", () => {
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
