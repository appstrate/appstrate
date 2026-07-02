// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { resetCatalog } from "../../catalog.ts";
import { buildMcpTools, type Dispatch } from "../../tools.ts";

const noExtra = {} as AppstrateRequestExtra;

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

function makeRunAndWait(opts: {
  permissions?: string[];
  launch?: () => Response;
  getRun?: Response[];
}): {
  tool: ReturnType<typeof buildMcpTools>[number];
  calls: Array<{ method: string; path: string; search: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const getRuns = [...(opts.getRun ?? [jsonResponse({ id: "run_1", status: "success" })])];
  const dispatch: Dispatch = async (req) => {
    const url = new URL(req.url);
    const body =
      req.method === "POST"
        ? await req
            .clone()
            .json()
            .catch(() => undefined)
        : undefined;
    calls.push({ method: req.method, path: url.pathname, search: url.search, body });

    if (
      req.method === "POST" &&
      (url.pathname.endsWith("/run") || url.pathname.endsWith("/inline"))
    ) {
      return (opts.launch ?? (() => jsonResponse({ id: "run_1", status: "pending" })))();
    }
    if (req.method === "GET" && /\/api\/runs\/[^/]+$/.test(url.pathname)) {
      return getRuns.shift() ?? jsonResponse({ id: "run_1", status: "success" });
    }
    throw new Error(`unexpected dispatch: ${req.method} ${url.pathname}`);
  };

  const tools = buildMcpTools({
    origin: "http://test.local",
    authHeaders: new Headers({ "X-Org-Id": "org_1", "X-Application-Id": "app_1" }),
    permissions: new Set(opts.permissions ?? ["mcp:invoke"]),
    dispatch,
  });
  const tool = tools.find((t) => t.descriptor.name === "run_and_wait");
  if (!tool) throw new Error("run_and_wait tool not built");
  return { tool, calls };
}

describe("run_and_wait", () => {
  beforeEach(() => resetCatalog());

  it("is registered as the single launch-and-wait tool", () => {
    const { tool } = makeRunAndWait({});
    expect(tool.descriptor.name).toBe("run_and_wait");
    expect(tool.descriptor.inputSchema.required).toEqual(["kind"]);
  });

  it("launches an agent run, then waits for the final result", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_42", packageId: "@acme/writer", status: "pending" }),
      getRun: [
        jsonResponse({
          id: "run_42",
          packageId: "@acme/writer",
          status: "success",
          result: { ok: true },
        }),
      ],
    });

    const res = await tool.handler(
      { kind: "agent", scope: "@acme", name: "writer", input: { topic: "x" } },
      noExtra,
    );

    expect(parseResult(res)).toMatchObject({
      id: "run_42",
      packageId: "@acme/writer",
      status: "success",
      done: true,
      result: { ok: true },
    });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ input: { topic: "x" } });
    expect(calls.find((c) => c.method === "GET")?.search).toBe("?wait=55");
  });

  it("launches an inline run without injecting metadata", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
      getRun: [jsonResponse({ id: "run_inline", status: "success" })],
    });

    await tool.handler({ kind: "inline", manifest: { name: "tmp" }, prompt: "do it" }, noExtra);

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      manifest: { name: "tmp" },
      prompt: "do it",
    });
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });

  it("surfaces launch failures", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ error: "nope" }, 404),
    });

    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);

    expect(res.isError).toBe(true);
    expect(parseResult(res).status).toBe(404);
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("rejects an inline run without a top-level prompt before dispatching", async () => {
    const { tool, calls } = makeRunAndWait({});

    const res = await tool.handler({ kind: "inline", manifest: { name: "tmp" } }, noExtra);

    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toContain("top-level argument");
    expect(calls.length).toBe(0);
  });

  it("tells the model to move a prompt nested inside the manifest", async () => {
    const { tool, calls } = makeRunAndWait({});

    const res = await tool.handler(
      { kind: "inline", manifest: { name: "tmp", prompt: "do it" } },
      noExtra,
    );

    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toContain("found inside `manifest`");
    expect(calls.length).toBe(0);
  });

  it("validates required arguments and permissions", async () => {
    const { tool } = makeRunAndWait({});
    expect((await tool.handler({ kind: "agent", name: "b" }, noExtra)).isError).toBe(true);
    expect((await tool.handler({ kind: "inline" }, noExtra)).isError).toBe(true);
    await expect(tool.handler({ kind: "bad" }, noExtra)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    } satisfies Partial<McpError>);

    const denied = makeRunAndWait({ permissions: ["mcp:read"] });
    const res = await denied.tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(denied.calls.length).toBe(0);
  });
});
