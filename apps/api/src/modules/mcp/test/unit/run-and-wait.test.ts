// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { resetCatalog } from "../../catalog.ts";
import { buildServerInstructions } from "../../router.ts";
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

const defaultInlineManifest = (overrides: Record<string, unknown>) => ({
  $schema: "https://schemas.afps.dev/v0/agent.schema.json",
  schema_version: "0.2",
  type: "agent",
  version: "1.0.0",
  dependencies: {},
  runtime_tools: ["log", "output", "publish_file"],
  output: { schema: { type: "object", properties: {}, additionalProperties: true } },
  ...overrides,
});

function makeRunAndWait(opts: {
  permissions?: string[];
  launch?: () => Response;
  getRun?: Response[];
  /** Rows the stubbed `GET /api/files?run_id=…` returns (published docs). */
  files?: Array<Record<string, unknown>>;
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
    // Post-completion file enrichment (fetchRunFiles).
    if (req.method === "GET" && url.pathname === "/api/files") {
      return jsonResponse({ object: "list", data: opts.files ?? [], hasMore: false });
    }
    throw new Error(`unexpected dispatch: ${req.method} ${url.pathname}`);
  };

  const tools = buildMcpTools({
    origin: "http://test.local",
    authHeaders: new Headers({ "X-Org-Id": "org_1", "X-Space-Id": "spc_1" }),
    // `runs:read` is in the default because the tool cannot function without
    // it: its second half polls `GET /api/runs/{id}` through the same dispatch,
    // under the caller's own scopes. A caller holding only `mcp:invoke` is
    // covered by its own case below, which asserts the refusal happens BEFORE
    // the launch.
    permissions: new Set(opts.permissions ?? ["mcp:invoke", "runs:read"]),
    dispatch,
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: "spc_1" },
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

  it("describes inline defaults and exact manifest overrides", () => {
    const { tool } = makeRunAndWait({});

    expect(tool.descriptor.description).toContain("publish_file");
    expect(tool.descriptor.description).toContain("build a `.zip` or `.afps` archive");
    expect(tool.descriptor.description).not.toContain("publish_archive");
    expect(tool.descriptor.description).toMatch(/fields you omit/i);
    expect(tool.descriptor.description).toContain("runtime_tools: []");
    expect(tool.descriptor.description).not.toMatch(/one main user-facing file/i);
    expect(tool.descriptor.description).not.toMatch(/several peer files/i);
    expect(tool.descriptor.inputSchema.properties).not.toHaveProperty("primary_deliverable");

    const manifestSchema = (
      tool.descriptor.inputSchema.properties as Record<string, Record<string, unknown>>
    ).manifest!;
    expect(manifestSchema.additionalProperties).toBe(true);
    expect(manifestSchema).not.toHaveProperty("required");
    expect(manifestSchema.properties).toEqual(
      expect.objectContaining({
        display_name: expect.any(Object),
        runtime_tools: expect.any(Object),
        output: expect.any(Object),
      }),
    );
  });

  // ── Argument-surface parity ────────────────────────────────────────────
  //
  // The launch body is built from an ALLOWLIST and the MCP transport does not
  // validate tool arguments, so an argument the dispatch does not read is not
  // rejected — it is INVISIBLE. These tests pin the two halves of the fix
  // behaviourally rather than by comparing two lists, because the guarantee is
  // "every declared name is honoured, every undeclared name is refused", not
  // "two arrays are equal".

  it("refuses an undeclared argument instead of silently dropping it", async () => {
    const { tool, calls } = makeRunAndWait({});

    const res = await tool.handler(
      { kind: "agent", scope: "@acme", name: "writer", contextFiles: ["appfile://file_1"] },
      noExtra,
    );

    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toContain("contextFiles");
    // The whole point: no launch happened. A silent drop would have 201'd.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
  });

  it("names the replacement for a retired argument", async () => {
    const { tool } = makeRunAndWait({});

    const res = await tool.handler(
      { kind: "inline", manifest: { display_name: "x" }, prompt: "p", context_documents: [] },
      noExtra,
    );

    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toContain("`context_files`");
  });

  it("accepts every argument the descriptor declares", async () => {
    const declared = Object.keys(
      makeRunAndWait({}).tool.descriptor.inputSchema.properties as Record<string, unknown>,
    );
    // Positive control: a name absent from this list is refused (previous test),
    // so an empty or truncated `declared` cannot make this pass vacuously.
    expect(declared).toContain("context_files");
    expect(declared.length).toBeGreaterThan(5);

    for (const name of declared) {
      const { tool } = makeRunAndWait({
        launch: () => jsonResponse({ id: "run_x", status: "pending" }),
        getRun: [jsonResponse({ id: "run_x", status: "success" })],
      });
      // A legal-but-minimal value per declared name, on an inline run (the kind
      // that accepts the widest set). `kind`/`manifest`/`prompt` are the base.
      const probe: Record<string, unknown> = {
        kind: "inline",
        manifest: { display_name: "probe" },
        prompt: "p",
      };
      if (name === "scope") probe.scope = "@acme";
      if (name === "name") probe.name = "writer";
      if (name === "version") probe.version = "draft";
      if (name === "input") probe.input = {};
      if (name === "connection_overrides") probe.connection_overrides = {};
      if (name === "context_files") probe.context_files = [];

      const res = await tool.handler(probe, noExtra);
      const payload = parseResult(res);
      const error = typeof payload.error === "string" ? payload.error : "";
      expect(error).not.toContain("Unknown argument");
    }
  });

  it("refuses a wrong-typed `input` on both kinds instead of launching without it", async () => {
    for (const probe of [
      { kind: "agent", scope: "@acme", name: "writer", input: '{"topic":"x"}' },
      { kind: "inline", manifest: { display_name: "x" }, prompt: "p", input: ["topic"] },
    ]) {
      const { tool, calls } = makeRunAndWait({});
      const res = await tool.handler(probe, noExtra);

      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toContain("`input` must be a JSON object");
      // The agent branch was the worse half: with `input` dropped the launch
      // body was empty, an empty body is sent as NO body, and the route reads
      // that as "no input" — a 201 on the agent's stored defaults.
      expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    }
  });

  it("describes package authoring with the remaining file publisher", () => {
    const instructions = buildServerInstructions(new Set(["mcp:read"]));

    expect(instructions).toContain("python3 -m zipfile -c package.afps");
    expect(instructions).toContain("publish that archive with `publish_file`");
    expect(instructions).not.toContain("publish_archive");
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

  it("launches an inline run from a minimal manifest without rewriting its prompt", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
      getRun: [jsonResponse({ id: "run_inline", status: "success" })],
    });

    await tool.handler(
      {
        kind: "inline",
        manifest: { display_name: "Do it" },
        prompt: "do it",
      },
      noExtra,
    );

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      manifest: defaultInlineManifest({ name: "@inline/do-it", display_name: "Do it" }),
      prompt: "do it",
    });
    expect(calls.some((c) => c.method === "GET")).toBe(true);
  });

  it("forwards `input` on an inline launch (appfile:// file fields reach the run)", async () => {
    const { tool, calls } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
      getRun: [jsonResponse({ id: "run_inline", status: "success" })],
    });

    await tool.handler(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        input: { screenshot: "appfile://file_abc12345" },
      },
      noExtra,
    );

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      manifest: defaultInlineManifest({ name: "tmp" }),
      prompt: expect.stringContaining("do it"),
      input: { screenshot: "appfile://file_abc12345" },
    });
  });

  // `connection_overrides` is the ONLY remedy for a `412 must_choose_connection`
  // launch, and the model can only use an argument the tool DECLARES. The
  // forwarding itself is unit-tested on `launchRunAndWait` (core); what is
  // proven here is the composition — descriptor + handler — because either half
  // could be dropped without the other suite noticing.
  describe("connection_overrides", () => {
    it("declares connection_overrides as an object of string values", () => {
      const { tool } = makeRunAndWait({});
      const property = (
        tool.descriptor.inputSchema.properties as Record<string, Record<string, unknown>>
      ).connection_overrides;
      expect(property).toBeDefined();
      expect(property!.type).toBe("object");
      // One connection id per integration — a non-string value map would let the
      // model send a shape the route rejects with a 400.
      expect(property!.additionalProperties).toEqual({ type: "string" });
      // Not required: the argument only exists for the retry after the 412, so
      // demanding it would break every ordinary launch. Pinned as an exact set
      // rather than a `not.toContain` — `kind` is the ONE required argument,
      // and a negative assertion on a single name can never fail.
      expect(tool.descriptor.inputSchema.required as string[]).toEqual(["kind"]);
    });

    it("forwards connection_overrides verbatim on an inline launch", async () => {
      const { tool, calls } = makeRunAndWait({
        launch: () => jsonResponse({ id: "run_inline", status: "pending" }),
        getRun: [jsonResponse({ id: "run_inline", status: "success" })],
      });

      await tool.handler(
        {
          kind: "inline",
          manifest: { name: "tmp" },
          prompt: "do it",
          connection_overrides: { "@acme/gmail": "conn_abc" },
        },
        noExtra,
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/runs/inline");
      expect(post?.body).toEqual({
        manifest: defaultInlineManifest({ name: "tmp" }),
        prompt: expect.stringContaining("do it"),
        connection_overrides: { "@acme/gmail": "conn_abc" },
      });
    });

    it("forwards connection_overrides verbatim on an agent launch", async () => {
      const { tool, calls } = makeRunAndWait({
        launch: () => jsonResponse({ id: "run_42", status: "pending" }),
        getRun: [jsonResponse({ id: "run_42", status: "success" })],
      });

      await tool.handler(
        {
          kind: "agent",
          scope: "@acme",
          name: "writer",
          connection_overrides: { "@acme/gmail": "conn_abc" },
        },
        noExtra,
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/agents/@acme/writer/run");
      expect(post?.body).toEqual({ connection_overrides: { "@acme/gmail": "conn_abc" } });
    });
  });

  it("returns a resource_link block per file the run published", async () => {
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
      files: [
        {
          id: "file_abcd1234",
          uri: "appfile://file_abcd1234",
          name: "report.html",
          mime: "text/html",
          size: 120,
          run_id: "run_7",
          // `fetchRunFiles` filters every returned row through
          // `isFileProducedByRun`, which needs BOTH halves — the run's file
          // container also holds the files mounted as its INPUT. The real
          // route always sends `purpose`, so the stub must too.
          purpose: "agent_output",
        },
      ],
    });

    const res = await tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, noExtra);

    // One resource_link per published file, alongside the text payload.
    const links = res.content.filter((c) => c.type === "resource_link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "resource_link",
      uri: "appfile://file_abcd1234",
      name: "report.html",
      mimeType: "text/html",
    });
    // The text payload also echoes the files (parity with the chat path).
    const docs = (parseResult(res).files as Array<Record<string, unknown>>) ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ uri: "appfile://file_abcd1234" });
  });

  it("returns only a text block when the run published no files", async () => {
    const { tool } = makeRunAndWait({
      launch: () => jsonResponse({ id: "run_8", status: "pending" }),
      getRun: [jsonResponse({ id: "run_8", status: "success" })],
      files: [],
    });

    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.content.every((c) => c.type === "text")).toBe(true);
    expect(parseResult(res).files).toBeUndefined();
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

  it("refuses a caller that can launch but not read, BEFORE launching", async () => {
    // `agents:run` without `runs:read` is a reachable credential — both are
    // separately requestable OIDC scopes, and it is the canonical shape of a
    // headless CI key. The launch dispatches in-process with the caller's own
    // auth, and `internal-dispatch` neither elevates nor alters identity, so
    // the poll would take a 403 on a run that is already provisioned and
    // already spending. `calls.length === 0` is the whole assertion: the
    // refusal has to precede the side effect, not follow it.
    const { tool, calls } = makeRunAndWait({ permissions: ["mcp:invoke"] });
    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toContain("runs:read");
    expect(calls.length).toBe(0);
  });
});
