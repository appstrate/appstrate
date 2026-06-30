// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `run_and_wait` MCP tool. Pure logic — no DB. Dispatch is
 * injected and routed by method+path so we can drive the launch → long-poll →
 * terminal sequence deterministically (the fake getRun returns instantly, so
 * the bounded wait loop consumes no real time).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { resetCatalog } from "../../catalog.ts";
import { buildMcpTools, type Dispatch } from "../../tools.ts";

const noExtra = {} as unknown as AppstrateRequestExtra;

function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build the run_and_wait tool over a dispatch driven by per-route handlers.
 * `getRun` may be a single value or a queue (consumed one per poll) to simulate
 * a run that stays running before it goes terminal.
 */
function makeRunAndWait(opts: {
  permissions?: string[];
  launch?: () => Response;
  getRun?: Response | Response[];
}) {
  const calls: { method: string; path: string; search: string; body?: unknown }[] = [];
  const getRunQueue = Array.isArray(opts.getRun) ? [...opts.getRun] : undefined;
  const dispatch: Dispatch = async (req) => {
    const url = new URL(req.url);
    let body: unknown;
    if (req.method !== "GET") {
      body = await req
        .clone()
        .json()
        .catch(() => undefined);
    }
    calls.push({ method: req.method, path: url.pathname, search: url.search, body });

    // Launch routes
    if (
      req.method === "POST" &&
      (url.pathname.endsWith("/run") || url.pathname.endsWith("/inline"))
    ) {
      return (opts.launch ?? (() => jsonResponse({ id: "run_1", status: "pending" })))();
    }
    // Run-get long-poll
    if (req.method === "GET" && /\/api\/runs\/[^/]+$/.test(url.pathname)) {
      if (getRunQueue)
        return getRunQueue.shift() ?? jsonResponse({ id: "run_1", status: "running" });
      return (
        (opts.getRun as Response) ?? jsonResponse({ id: "run_1", status: "success", result: {} })
      );
    }
    throw new Error(`unexpected dispatch: ${req.method} ${url.pathname}`);
  };

  const tools = buildMcpTools({
    origin: "https://test.local",
    authHeaders: new Headers({ authorization: "Bearer tok", "x-org-id": "org_1" }),
    permissions: new Set(opts.permissions ?? ["mcp:invoke"]),
    dispatch,
  });
  const tool = tools.find((t) => t.descriptor.name === "run_and_wait");
  if (!tool) throw new Error("run_and_wait tool not built");
  return { tool, calls };
}

describe("run_and_wait", () => {
  beforeEach(() => resetCatalog());

  it("is registered in the tool set", () => {
    const { tool } = makeRunAndWait({});
    expect(tool.descriptor.name).toBe("run_and_wait");
    expect(tool.descriptor.annotations?.readOnlyHint).toBe(false);
  });

  it("launches an agent run and returns the terminal result", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_42", status: "pending" }),
      getRun: jsonResponse({ id: "run_42", status: "success", result: { answer: 7 }, error: null }),
    });
    const res = await tool.handler(
      { kind: "agent", scope: "@acme", name: "writer", input: { topic: "x" } },
      noExtra,
    );
    const body = parseResult(res);
    expect(body.id).toBe("run_42");
    expect(body.status).toBe("success");
    expect(body.done).toBe(true);
    expect(body.result).toEqual({ answer: 7 });

    // Launch hit the agent run route with the scope/name path + input body.
    const launch = calls.find((c) => c.method === "POST");
    expect(launch?.path).toBe("/api/agents/@acme/writer/run");
    expect(launch?.body).toEqual({ input: { topic: "x" } });
    // Followed with a long-poll on the returned id.
    const poll = calls.find((c) => c.method === "GET");
    expect(poll?.path).toBe("/api/runs/run_42");
    expect(poll?.search).toContain("wait=");
  });

  it("passes the version selector as a query param", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_1", status: "pending" }),
      getRun: jsonResponse({ id: "run_1", status: "success" }),
    });
    await tool.handler({ kind: "agent", scope: "@acme", name: "a", version: "draft" }, noExtra);
    const launch = calls.find((c) => c.method === "POST");
    expect(launch?.search).toContain("version=draft");
  });

  it("launches an inline run from a manifest + prompt", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
      getRun: jsonResponse({ id: "run_inline", status: "success", result: { ok: true } }),
    });
    const res = await tool.handler(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      noExtra,
    );
    const body = parseResult(res);
    expect(body.done).toBe(true);
    const launch = calls.find((c) => c.method === "POST");
    expect(launch?.path).toBe("/api/runs/inline");
    expect(launch?.body).toEqual({ manifest: { name: "tmp" }, prompt: "do it" });
  });

  it("long-polls across multiple windows until terminal", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_1", status: "pending" }),
      getRun: [
        jsonResponse({ id: "run_1", status: "running" }),
        jsonResponse({ id: "run_1", status: "success", result: { done: 1 } }),
      ],
    });
    const res = await tool.handler(
      { kind: "agent", scope: "@a", name: "b", max_wait_seconds: 110 },
      noExtra,
    );
    const body = parseResult(res);
    expect(body.done).toBe(true);
    expect(body.status).toBe("success");
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  it("returns done:false with a follow-up hint when the run outlives the budget", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_1", status: "pending" }),
      getRun: jsonResponse({ id: "run_1", status: "running" }),
    });
    const res = await tool.handler(
      { kind: "agent", scope: "@a", name: "b", max_wait_seconds: 55 },
      noExtra,
    );
    const body = parseResult(res);
    expect(body.done).toBe(false);
    expect(body.status).toBe("running");
    expect(typeof body.hint).toBe("string");
    expect(body).not.toHaveProperty("result");
  });

  it("surfaces a launch failure verbatim (no follow-up poll)", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ error: "no_published_version" }, 404),
    });
    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    const body = parseResult(res);
    expect(body.status).toBe(404);
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("surfaces a getRun failure during follow", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_1", status: "pending" }),
      getRun: jsonResponse({ error: "not_found" }, 404),
    });
    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(parseResult(res).status).toBe(404);
  });

  it("errors when the launch returns no run id", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ status: "pending" }),
    });
    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(String(parseResult(res).error)).toContain("no run id");
  });

  it("requires scope and name for kind:agent", async () => {
    const { tool } = makeRunAndWait({});
    const res = await tool.handler({ kind: "agent", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(String(parseResult(res).error)).toContain("scope");
  });

  it("requires a manifest for kind:inline", async () => {
    const { tool } = makeRunAndWait({});
    const res = await tool.handler({ kind: "inline", prompt: "x" }, noExtra);
    expect(res.isError).toBe(true);
    expect(String(parseResult(res).error)).toContain("manifest");
  });

  it("rejects an invalid kind with InvalidParams", async () => {
    const { tool } = makeRunAndWait({});
    await expect(tool.handler({ kind: "bogus" }, noExtra)).rejects.toBeInstanceOf(McpError);
    await expect(tool.handler({ kind: "bogus" }, noExtra)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it("denies the call without mcp:invoke", async () => {
    const { tool, calls } = makeRunAndWait({ permissions: ["mcp:read"] });
    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(String(parseResult(res).error)).toContain("mcp:invoke");
    expect(calls.length).toBe(0);
  });

  it("clamps max_wait_seconds above the cap (still terminates promptly here)", async () => {
    // 99999 is clamped to MAX_RUN_WAIT_SECONDS internally; the run goes terminal
    // on the first poll so the loop exits regardless — we just assert no throw
    // and a single poll.
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_1", status: "pending" }),
      getRun: jsonResponse({ id: "run_1", status: "success" }),
    });
    const res = await tool.handler(
      { kind: "agent", scope: "@a", name: "b", max_wait_seconds: 99999 },
      noExtra,
    );
    expect(parseResult(res).done).toBe(true);
    expect(calls.filter((c) => c.method === "GET").length).toBe(1);
  });
});
