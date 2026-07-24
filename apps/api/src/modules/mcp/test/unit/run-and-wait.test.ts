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
  /** Rows the stubbed `GET /api/documents?run_id=…` returns (published docs). */
  documents?: Array<Record<string, unknown>>;
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
    // Post-completion document enrichment (fetchRunDocuments).
    if (req.method === "GET" && url.pathname === "/api/documents") {
      return jsonResponse({ object: "list", data: opts.documents ?? [], hasMore: false });
    }
    throw new Error(`unexpected dispatch: ${req.method} ${url.pathname}`);
  };

  const tools = buildMcpTools({
    origin: "http://test.local",
    authHeaders: new Headers({ "X-Org-Id": "org_1", "X-Application-Id": "app_1" }),
    permissions: new Set(opts.permissions ?? ["mcp:invoke"]),
    dispatch,
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", applicationId: "app_1" },
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

  it("forwards `input` on an inline launch (document:// file fields reach the run)", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
      getRun: [jsonResponse({ id: "run_inline", status: "success" })],
    });

    await tool.handler(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        input: { screenshot: "document://doc_abc12345" },
      },
      noExtra,
    );

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      manifest: { name: "tmp" },
      prompt: "do it",
      input: { screenshot: "document://doc_abc12345" },
    });
  });

  it("returns a resource_link block per document the run published", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_7", packageId: "@acme/writer", status: "pending" }),
      getRun: [
        jsonResponse({
          id: "run_7",
          packageId: "@acme/writer",
          status: "success",
          result: { ok: true },
        }),
      ],
      documents: [
        {
          id: "doc_abcd1234",
          uri: "document://doc_abcd1234",
          name: "report.html",
          mime: "text/html",
          size: 120,
        },
      ],
    });

    const res = await tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, noExtra);

    // One resource_link per published document, alongside the text payload.
    const links = res.content.filter((c) => c.type === "resource_link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "resource_link",
      uri: "document://doc_abcd1234",
      name: "report.html",
      mimeType: "text/html",
    });
    // The text payload also echoes the documents (parity with the chat path).
    const docs = (parseResult(res).documents as Array<Record<string, unknown>>) ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ uri: "document://doc_abcd1234" });
  });

  it("returns only a text block when the run published no documents", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_8", status: "pending" }),
      getRun: [jsonResponse({ id: "run_8", status: "success" })],
      documents: [],
    });

    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.content.every((c) => c.type === "text")).toBe(true);
    expect(parseResult(res).documents).toBeUndefined();
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
