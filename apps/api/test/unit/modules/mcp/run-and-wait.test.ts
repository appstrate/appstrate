// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, jest } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createInProcessPair, type AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import {
  RUN_AND_WAIT_LONG_POLL_RESUME,
  RUN_AND_WAIT_PROGRESS_INTERVAL_MS,
  RUN_AND_WAIT_UNSTREAMED_MAX_MS,
  type Dispatch,
  type McpToolContext,
  type McpToolEvent,
} from "../../../../src/modules/mcp/tools.ts";
import {
  RUN_AND_WAIT_MAX_MS,
  RUN_AND_WAIT_RESUME_INSTRUCTION,
  RUN_CONNECT_OFFERS_HEADER,
} from "@appstrate/core/run-and-wait-client";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  MAX_CONNECTIONS_PER_INTEGRATION,
} from "@appstrate/core/integration";
import { AFPS_SCHEMA_URLS, AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import { registerTestPlatformApp } from "../../../helpers/platform-app.ts";
import { instructionsFor, toolsFor } from "./helpers.ts";

// Both `buildMcpTools` (what this caller is shown) and the appended operation
// index read the mounted guards off the route table.
await registerTestPlatformApp();

const noExtra = {} as AppstrateRequestExtra;

/** What composing an inline agent takes: authoring AND launching. */
const COMPOSER = ["agents:write", "agents:run"];
/**
 * `run_and_wait` is declared only to a caller who can launch AND read the run
 * back, so every permission set here carries a run-read grant — the tool is
 * simply absent otherwise, which `tools.test.ts` pins.
 */
const LAUNCHES = ["mcp:invoke", "runs:read"];

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
  $schema: AFPS_SCHEMA_URLS.agent,
  schema_version: AFPS_SCHEMA_VERSION,
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
  /** Successive poll answers; a function answers (given the poll request) when its promise settles. */
  getRun?: Array<Response | ((req: Request) => Promise<Response>)>;
  /** Rows the stubbed `GET /api/files?runId=…` returns (published docs). */
  files?: Array<Record<string, unknown>>;
}): {
  tool: ReturnType<typeof toolsFor>[number];
  calls: Array<{
    method: string;
    path: string;
    search: string;
    body: unknown;
    /** The connect-offer opt-in, recorded per request (launch-only contract). */
    connectOffers: string | null;
  }>;
  events: McpToolEvent[];
} {
  const events: McpToolEvent[] = [];
  const calls: Array<{
    method: string;
    path: string;
    search: string;
    body: unknown;
    connectOffers: string | null;
  }> = [];
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
    calls.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      connectOffers: req.headers.get(RUN_CONNECT_OFFERS_HEADER),
    });

    if (
      req.method === "POST" &&
      (url.pathname.endsWith("/run") || url.pathname.endsWith("/inline"))
    ) {
      return (opts.launch ?? (() => jsonResponse({ id: "run_1", status: "pending" })))();
    }
    if (req.method === "GET" && /\/api\/runs\/[^/]+$/.test(url.pathname)) {
      const next = getRuns.shift() ?? jsonResponse({ id: "run_1", status: "success" });
      return typeof next === "function" ? next(req) : next;
    }
    // Post-completion file enrichment (fetchRunFiles).
    if (req.method === "GET" && url.pathname === "/api/files") {
      return jsonResponse({ object: "list", data: opts.files ?? [], hasMore: false });
    }
    throw new Error(`unexpected dispatch: ${req.method} ${url.pathname}`);
  };

  const ctx: McpToolContext = {
    origin: "http://test.local",
    authHeaders: new Headers({ "X-Org-Id": "org_1", "X-Space-Id": "spc_1" }),
    // `runs:read` is in the default because the tool cannot function without
    // it: its second half polls `GET /api/runs/{id}` through the same dispatch,
    // under the caller's own scopes — and the tool is not even declared to a
    // caller missing it. `agents:write` + `agents:run` make the default
    // descriptor the full one; the agent-only descriptor has its own block below.
    permissions: new Set(opts.permissions ?? [...LAUNCHES, ...COMPOSER]),
    ceiling: undefined,
    dispatch,
    actor: { type: "user", id: "user_1" },
    scope: { orgId: "org_1", spaceId: "spc_1" },
    authorizeBundle: async () => {},
    mayShareRoot: async () => false,
    readSkill: () => Promise.reject(new Error("read_skill is not exercised here")),
    requestId: "req_test",
    observe: (event) => events.push(event),
  };
  const tools = toolsFor(ctx);
  const tool = tools.find((t) => t.descriptor.name === "run_and_wait");
  if (!tool) throw new Error("run_and_wait tool not built");
  return { tool, calls, events };
}

describe("run_and_wait", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("is registered as the single launch-and-wait tool", () => {
    const { tool } = makeRunAndWait({});
    expect(tool.descriptor.name).toBe("run_and_wait");
    expect(tool.descriptor.inputSchema.required).toEqual(["kind"]);
  });

  it("promises the launch warnings in its result shape", () => {
    const { tool } = makeRunAndWait({});
    expect(tool.descriptor.description).toContain(
      "`{ id, packageId, status, done:true, result?, error?, warnings }`",
    );
    for (const code of CONNECTION_RESOLUTION_WARNING_CODES) {
      expect(tool.descriptor.description).toContain(`\`${code}\``);
    }
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

    const call = tool.handler(
      { kind: "agent", scope: "@acme", name: "writer", contextFiles: ["appfile://file_1"] },
      noExtra,
    );

    const refused = await call;
    expect(refused.isError).toBe(true);
    expect(parseResult(refused)).toMatchObject({
      code: "unknown_argument",
      arguments: expect.arrayContaining(["contextFiles"]),
      accepted: expect.arrayContaining(["context_files"]),
    });
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
    expect(parseResult(res).error).toMatch(
      /Unknown argument\(s\): context_documents\. Accepted: .*context_files/,
    );
  });

  it("refuses an inline-only argument the caller's descriptor does not declare", async () => {
    const { tool, calls } = makeRunAndWait({ permissions: [...LAUNCHES, "agents:run"] });

    const res = await tool.handler(
      { kind: "agent", scope: "@acme", name: "writer", prompt: "p" },
      noExtra,
    );
    expect(res.isError).toBe(true);
    expect(parseResult(res)).toMatchObject({ code: "unknown_argument", arguments: ["prompt"] });
    expect(calls).toHaveLength(0);
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
    const instructions = instructionsFor(["mcp:read", ...LAUNCHES, ...COMPOSER]);

    expect(instructions).toContain("python3 -m zipfile -c package.afps");
    expect(instructions).toContain("publish that archive with `publish_file`");
    expect(instructions).not.toContain("publish_archive");
  });

  // ── Advertised to the caller's grant ───────────────────────────────────
  //
  // `POST /api/runs/inline` requires `agents:write` and `agents:run`, so a
  // descriptor that offered `kind:"inline"` to a caller missing either would
  // send the model into a 403. Whether the tool is declared at all is a
  // separate gate, pinned in `tools.test.ts`.

  describe("without `agents:write` ∧ `agents:run`", () => {
    const agentOnly = () => makeRunAndWait({ permissions: [...LAUNCHES, "agents:run"] }).tool;

    it('offers `kind:"inline"` only when both are held', () => {
      const kinds = (permissions: string[]) =>
        (
          makeRunAndWait({ permissions: [...LAUNCHES, ...permissions] }).tool.descriptor.inputSchema
            .properties as Record<string, { enum?: string[] }>
        ).kind!.enum;
      expect(kinds(["agents:run"])).toEqual(["agent"]);
      expect(kinds(COMPOSER)).toEqual(["agent", "inline"]);
    });

    it("declares none of the inline-only arguments", () => {
      const declared = Object.keys(
        agentOnly().descriptor.inputSchema.properties as Record<string, unknown>,
      );
      const full = Object.keys(
        makeRunAndWait({}).tool.descriptor.inputSchema.properties as Record<string, unknown>,
      );
      for (const name of ["manifest", "prompt", "context_files"]) {
        expect(declared).not.toContain(name);
        expect(full).toContain(name);
      }
      const shared = ["kind", "scope", "name", "version", "input", "connection_overrides"];
      expect(declared).toEqual(expect.arrayContaining(shared));
    });

    it("mentions inline runs nowhere in the descriptor", () => {
      const descriptor = JSON.stringify(agentOnly().descriptor);
      expect(descriptor).not.toMatch(/inline|context_files|manifest/i);
      expect(JSON.stringify(makeRunAndWait({}).tool.descriptor)).toContain(
        "Chaining runs (kind:inline)",
      );
    });

    it("leaves inline runs out of the server instructions", () => {
      // The operation index is a coarse, tag-level list — cut it off; only the
      // prose is this caller's to be told.
      const prose = (permissions: string[]) => {
        const instructions = instructionsFor(permissions, true);
        return instructions.slice(0, instructions.indexOf(OPERATION_INDEX_HEADING));
      };
      // Both sides can run — only authoring differs, so what disappears is
      // the inline half and not the run prose around it.
      const without = prose(["mcp:read", ...LAUNCHES, "agents:run"]);
      const withGrant = prose(["mcp:read", ...LAUNCHES, ...COMPOSER]);
      expect(without).not.toMatch(/inline/i);
      expect(without).toContain("validate_package_file");
      expect(withGrant).toContain("runInline");
      expect(withGrant).toContain("validateInlineRun");
      expect(withGrant).toContain("have one inline run create the manifest");
    });
  });

  it("launches an agent run, then waits for the final result", async () => {
    // Frozen clock: the poll's `wait` must not depend on how long the launch took.
    jest.useFakeTimers();
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
    // No progress token: the wait is capped below the clients' 60 s timeout.
    expect(calls.find((c) => c.method === "GET")?.search).toBe(
      `?wait=${RUN_AND_WAIT_UNSTREAMED_MAX_MS / 1000}`,
    );
  });

  it("serves a truncated, file-enriched result that passes the server's outputSchema check", async () => {
    const { tool } = makeRunAndWait({
      getRun: [
        jsonResponse({ id: "run_1", status: "success", result: { blob: "x".repeat(40_000) } }),
      ],
      files: [
        {
          id: "file_1",
          uri: "appfile://file_1",
          name: "report.md",
          mime: "text/markdown",
          size: 12,
          purpose: "agent_output",
          runId: "run_1",
        },
      ],
    });
    // Through `createMcpServer`, so a projection drifting from RunAndWaitResult fails here.
    const pair = await createInProcessPair([tool]);
    try {
      const res = (await pair.client.callTool({
        name: "run_and_wait",
        arguments: { kind: "agent", scope: "@acme", name: "writer" },
      })) as CallToolResult;
      expect(res.structuredContent).toMatchObject({ done: true, truncated: true });
      expect(res.structuredContent).not.toHaveProperty("result");
      expect((res.structuredContent as { files: unknown[] }).files).toHaveLength(1);
    } finally {
      await pair.close();
    }
  });

  it("reports a failed poll's own HTTP status in telemetry", async () => {
    const { tool, events } = makeRunAndWait({
      getRun: [jsonResponse({ type: "about:blank", status: 404 }, 404)],
    });
    const res = await tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, noExtra);

    expect(res.isError).toBe(true);
    expect(events.find((e) => e.operationId === "getRun")?.status).toBe(404);
  });

  describe("progress heartbeat and unstreamed wait cap", () => {
    type SentNotification = Parameters<AppstrateRequestExtra["sendNotification"]>[0];

    it("tells the model to read a `done:false` run back with getRun, not relaunch it", () => {
      const description = makeRunAndWait({}).tool.descriptor.description;
      expect(description).toContain("`done:false`");
      expect(description).toContain("never call `run_and_wait` again");
      expect(description).toContain(RUN_AND_WAIT_RESUME_INSTRUCTION);
      // The chat reuses this text with only its closing-reply margin left: no long-poll advice.
      expect(description).not.toContain("wait: true");
    });

    function extraWith(
      progressToken: string | number | undefined,
      send: (n: SentNotification) => Promise<void>,
    ): AppstrateRequestExtra {
      return {
        ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
        sendNotification: send,
      } as AppstrateRequestExtra;
    }

    /**
     * A poll answer held until `settle` is called; like a real fetch, it rejects
     * when the request's signal aborts (the core's per-poll deadline).
     */
    function heldPoll(): {
      answer: (req: Request) => Promise<Response>;
      settle: (body: Record<string, unknown>) => void;
    } {
      let settle: (body: Record<string, unknown>) => void = () => {
        throw new Error("poll not dispatched yet");
      };
      const answer = (req: Request) =>
        new Promise<Response>((resolve, reject) => {
          settle = (body) => resolve(jsonResponse(body));
          req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
        });
      return { answer, settle: (body) => settle(body) };
    }

    /** Let pending promise chains run without moving the fake clock. */
    async function flush(): Promise<void> {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    /**
     * Start the call and return once its poll is in flight. Wrapped: an async
     * function returning the bare promise would adopt it and wait for the result.
     */
    async function startCall(
      tool: ReturnType<typeof makeRunAndWait>["tool"],
      calls: ReturnType<typeof makeRunAndWait>["calls"],
      extra: AppstrateRequestExtra,
    ): Promise<{ pending: Promise<CallToolResult> }> {
      const pending = tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, extra);
      for (let i = 0; i < 50 && !calls.some((c) => c.method === "GET"); i++) await flush();
      expect(calls.some((c) => c.method === "GET")).toBe(true);
      return { pending };
    }

    it("streams strictly increasing progress under the caller's token, then stops", async () => {
      jest.useFakeTimers();
      const poll = heldPoll();
      const sent: SentNotification[] = [];
      const { tool, calls } = makeRunAndWait({ getRun: [poll.answer] });

      const { pending } = await startCall(
        tool,
        calls,
        extraWith("tok_1", async (n) => {
          sent.push(n);
        }),
      );
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(RUN_AND_WAIT_PROGRESS_INTERVAL_MS);
        await flush();
      }
      poll.settle({ id: "run_1", status: "success" });
      const res = await pending;
      jest.advanceTimersByTime(RUN_AND_WAIT_PROGRESS_INTERVAL_MS * 4);
      await flush();

      expect(parseResult(res)).toMatchObject({ id: "run_1", status: "success", done: true });
      // A streamed call asks for its whole default budget; the server clamps it.
      expect(calls.find((c) => c.method === "GET")?.search).toBe(
        `?wait=${RUN_AND_WAIT_MAX_MS / 1000}`,
      );
      // One beat at launch, then one per interval.
      expect(sent).toEqual(
        [
          "Run run_1 launched",
          ...[1, 2, 3].map(
            (n) =>
              `Waiting for run run_1 (${(n * RUN_AND_WAIT_PROGRESS_INTERVAL_MS) / 1000}s elapsed)`,
          ),
        ].map((message, i) => ({
          method: "notifications/progress",
          params: { progressToken: "tok_1", progress: i + 1, message },
        })),
      );
    });

    it("never fails the call when sending a notification throws", async () => {
      jest.useFakeTimers();
      const poll = heldPoll();
      let attempts = 0;
      const { tool, calls } = makeRunAndWait({ getRun: [poll.answer] });

      const { pending } = await startCall(
        tool,
        calls,
        extraWith(7, () => {
          attempts += 1;
          throw new Error("transport closed");
        }),
      );
      for (let i = 0; i < 2; i++) {
        jest.advanceTimersByTime(RUN_AND_WAIT_PROGRESS_INTERVAL_MS);
        await flush();
      }
      poll.settle({ id: "run_1", status: "success" });
      const res = await pending;

      expect(attempts).toBe(3); // the launch beat + two intervals
      expect(res.isError).toBeFalsy();
      expect(parseResult(res)).toMatchObject({ id: "run_1", status: "success", done: true });
    });

    it("sends nothing and returns done:false with the run id once the cap passes", async () => {
      jest.useFakeTimers();
      const sent: SentNotification[] = [];
      const { tool, calls, events } = makeRunAndWait({
        launch: () => jsonResponse({ id: "run_7", packageId: "@acme/writer", status: "pending" }),
        getRun: [heldPoll().answer],
      });

      const { pending } = await startCall(
        tool,
        calls,
        extraWith(undefined, async (n) => {
          sent.push(n);
        }),
      );
      jest.advanceTimersByTime(RUN_AND_WAIT_UNSTREAMED_MAX_MS);
      const res = await pending;

      expect(calls.find((c) => c.method === "GET")?.search).toBe(
        `?wait=${RUN_AND_WAIT_UNSTREAMED_MAX_MS / 1000}`,
      );
      expect(res.isError).toBeFalsy();
      // `done` alone says the wait ended; the next step comes as a second text block.
      expect(res.structuredContent).toEqual({
        id: "run_7",
        packageId: "@acme/writer",
        status: "pending",
        done: false,
        warnings: [],
      });
      expect(res.content.slice(1)).toEqual([{ type: "text", text: RUN_AND_WAIT_LONG_POLL_RESUME }]);
      // Nothing to enrich on a run still going: no file read, and no 200 getRun in telemetry.
      expect(calls.some((c) => c.path === "/api/files")).toBe(false);
      expect(events.at(-1)).toMatchObject({ tool: "run_and_wait", runStatus: "pending" });
      expect(events.some((e) => e.operationId === "getRun")).toBe(false);
      expect(sent).toEqual([]);
    });
  });

  it("ends its telemetry on the run's status when the wait reaches a terminal run", async () => {
    const { tool, events } = makeRunAndWait({
      getRun: [jsonResponse({ id: "run_1", status: "success" })],
    });
    await tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, noExtra);
    expect(events.at(-1)).toMatchObject({ tool: "run_and_wait", runStatus: "success" });
  });

  it("opts the launch into connect offers, and only the launch", async () => {
    // The MCP client is a human's own client, so a 409 may carry the link that
    // human opens. The poll has no 409 to enrich, so it must stay opt-out.
    const { tool, calls } = makeRunAndWait({
      getRun: [jsonResponse({ id: "run_1", status: "success" })],
    });
    await tool.handler({ kind: "agent", scope: "@acme", name: "writer" }, noExtra);

    expect(calls.find((c) => c.method === "POST")?.connectOffers).toBe("1");
    expect(calls.find((c) => c.method === "GET")?.connectOffers).toBeNull();
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

  // `connection_overrides` is the ONLY remedy for a `409 must_choose_connection`
  // launch AND the only way to bind several connections of one integration, and
  // the model can only use an argument the tool DECLARES. The
  // forwarding itself is unit-tested on `launchRunAndWait` (core); what is
  // proven here is the composition — descriptor + handler — because either half
  // could be dropped without the other suite noticing.
  describe("connection_overrides", () => {
    it("declares connection_overrides as an object of bounded string arrays", () => {
      const { tool } = makeRunAndWait({});
      const property = (
        tool.descriptor.inputSchema.properties as Record<string, Record<string, unknown>>
      ).connection_overrides;
      expect(property).toBeDefined();
      expect(property!.type).toBe("object");
      // 0..MAX connection ids per integration (`[]` = none), always an array — the route's shape.
      expect(property!.additionalProperties).toEqual({
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 0,
        maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
        uniqueItems: true,
        description: expect.any(String),
      });
      // Not required: the argument only exists for the retry after the 409, so
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
          connection_overrides: { "@acme/gmail": ["conn_abc"] },
        },
        noExtra,
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/runs/inline");
      expect(post?.body).toEqual({
        manifest: defaultInlineManifest({ name: "tmp" }),
        prompt: expect.stringContaining("do it"),
        connection_overrides: { "@acme/gmail": ["conn_abc"] },
      });
    });

    // Two ids under one key is what the array shape exists for. The one-element
    // launch above is the control: it must keep going through untouched, so a
    // handler that simply refused every multi-id map could not pass both.
    it("forwards two connection ids for one integration verbatim", async () => {
      const { tool, calls } = makeRunAndWait({
        launch: () => jsonResponse({ id: "run_multi", status: "pending" }),
        getRun: [jsonResponse({ id: "run_multi", status: "success" })],
      });

      await tool.handler(
        {
          kind: "inline",
          manifest: { name: "tmp" },
          prompt: "do it",
          connection_overrides: { "@acme/ssh": ["conn_web1", "conn_db"] },
        },
        noExtra,
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.body).toMatchObject({
        connection_overrides: { "@acme/ssh": ["conn_web1", "conn_db"] },
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
          connection_overrides: { "@acme/gmail": ["conn_abc"] },
        },
        noExtra,
      );

      const post = calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/agents/@acme/writer/run");
      expect(post?.body).toEqual({ connection_overrides: { "@acme/gmail": ["conn_abc"] } });
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
          runId: "run_7",
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

  it("validates required arguments, telling an absent one from a malformed one", async () => {
    const { tool } = makeRunAndWait({});
    const noScope = await tool.handler({ kind: "agent", name: "b" }, noExtra);
    expect(noScope.isError).toBe(true);
    expect(parseResult(noScope)).toMatchObject({
      code: "missing_argument",
      arguments: ["scope"],
    });
    const badScope = await tool.handler({ kind: "agent", scope: 7, name: "b" }, noExtra);
    expect(parseResult(badScope)).toMatchObject({ code: "invalid_argument", arguments: ["scope"] });
    const noManifest = await tool.handler({ kind: "inline" }, noExtra);
    expect(noManifest.isError).toBe(true);
    expect(parseResult(noManifest)).toMatchObject({
      code: "missing_argument",
      arguments: ["manifest"],
    });
    const badManifest = await tool.handler({ kind: "inline", manifest: "{}" }, noExtra);
    expect(parseResult(badManifest)).toMatchObject({
      code: "invalid_argument",
      arguments: ["manifest"],
    });
    const noPrompt = await tool.handler({ kind: "inline", manifest: { name: "tmp" } }, noExtra);
    expect(parseResult(noPrompt)).toMatchObject({
      code: "missing_argument",
      arguments: ["prompt"],
    });
    const noKind = await tool.handler({}, noExtra);
    expect(parseResult(noKind)).toMatchObject({ code: "missing_argument", arguments: ["kind"] });
    const badInput = await tool.handler(
      { kind: "agent", scope: "@a", name: "b", input: "{}" },
      noExtra,
    );
    expect(parseResult(badInput)).toMatchObject({ code: "invalid_argument", arguments: ["input"] });
    const bad = await tool.handler({ kind: "bad" }, noExtra);
    expect(bad.isError).toBe(true);
    expect(parseResult(bad)).toMatchObject({ code: "invalid_argument", arguments: ["kind"] });
  });

  it("launches for a caller whose only run-read grant is `runs:read-all`", async () => {
    // `read-all` is a superset of `read`, not a companion to it
    // (`lib/run-visibility.ts`), and `runs:read-all` is separately grantable to
    // an API key. A literal `runs:read` test would refuse this principal even
    // though the poll route it gates reads every run in the space.
    const { tool, calls } = makeRunAndWait({
      permissions: ["mcp:invoke", "agents:run", "runs:read-all"],
    });

    const res = await tool.handler({ kind: "agent", scope: "@a", name: "b" }, noExtra);

    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.method === "POST")).toBeDefined();
  });
});
