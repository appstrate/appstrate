// SPDX-License-Identifier: Apache-2.0

/**
 * The one test that drives `runPiChat` for real.
 *
 * Every other chat suite injects a scripted engine so a turn never opens a Pi
 * session against a provider — correct for testing the route, and the reason
 * the engine that now serves 100% of chat sat at ~5% line coverage. Here a
 * local stub plays BOTH servers the engine talks to (the platform MCP endpoint
 * it opens itself, and the llm-proxy the proxy binding points it at), so a
 * genuine `@earendil-works/pi-coding-agent` session runs end to end with no
 * network and no provider key.
 *
 * What it asserts is what only a real session can show:
 *   - the UI-message-stream chunk sequence the client consumes,
 *   - `before_provider_headers` replacing `Authorization` on the provider
 *     request, with the inert `proxy` runtime key never reaching the wire,
 *   - a proxy-bound turn recording NO inline usage (llm-proxy owns metering,
 *     so an inline row would double-bill),
 *   - the concurrency slot released once the response stream drains.
 *
 * It is NOT a second copy of the mapper's unit tests, and it does not assert
 * pi-ai's own request shape — that is the SDK's contract, not ours.
 */

import { describe, it, expect, afterAll, afterEach, mock, spyOn } from "bun:test";
import type { UIMessage } from "ai";
import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_TOOL_STEP_BUDGET,
} from "@appstrate/core/chat-turn-metadata";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { acquirePiChatSlot } from "../src/pi-chat/concurrency.ts";
import { runPiChat, type PiChatInput } from "../src/pi-chat/engine.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { logger } from "../src/logger.ts";
import { getPiModel, piModelDialect } from "@appstrate/runner-pi/pi-model";
import type { OrgModel } from "../src/llm.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const ANSWER = "Bonjour le monde";

const LIVE_ORGANIZATION = inertTurnSpaces([
  { id: "spc_live", name: "Live", role: "admin", permissions: [] },
]);
/** Distinct from the preset id, so a label defaulted to the id is caught. */
const LIVE_MODEL_LABEL = "Live Preset (display)";

interface Capture {
  /** Authorization header seen on each provider request. */
  authHeaders: string[];
  /** Raw body of each provider request. */
  bodies: string[];
}

/**
 * Minimal Streamable-HTTP MCP server: answers `initialize` and `tools/list`
 * (empty). A GET returns 405 so the client's best-effort inbound SSE probe is a
 * clean no-op. The engine THROWS if this handshake fails, so it is not optional
 * — this is the supported "module present, zero tools" shape.
 */
/**
 * When set, the stub blocks on this before answering `initialize`. Lets a test
 * prove the UI stream opens BEFORE the handshake: if the `start` chunk were
 * still written after it, reading the first chunk would deadlock rather than
 * return, and the test times out instead of passing for the wrong reason.
 */
// Module-level, and therefore process-level: `mcpResponse` awaits it on EVERY
// subsequent handshake. Cleared in `afterEach` rather than in the one test's
// `finally`, because the failure that test guards against is a TIMEOUT — and a
// timed-out body never reaches its `finally`. A gate left pending would then
// hang every later turn in this file at 30 s apiece, burying the one real
// failure under a cascade. Harmless today only because that test happens to be
// last in the describe.
let mcpInitGate: Promise<void> | null = null;

/** What the stub's handshake advertises (reset in `afterEach`), and how often it ran. */
interface StubSurface {
  instructions?: string;
  tools: unknown[];
  /** Drive one actual provider tool call on the Responses wire and answer it via MCP. */
  call?: { name: string; arguments: Record<string, unknown>; steps: number; result: unknown };
}
const EMPTY_SURFACE: StubSurface = { tools: [] };
let mcpSurface: StubSurface = EMPTY_SURFACE;
let mcpInitializes = 0;
/** `tools/call` requests the stub answered. Reset in `afterEach`. */
let mcpToolCalls = 0;

async function mcpResponse(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
  const json = (result: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });
  if (msg.method === "initialize") {
    mcpInitializes++;
    if (mcpInitGate) await mcpInitGate;
    return json(
      {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        ...(mcpSurface.instructions ? { instructions: mcpSurface.instructions } : {}),
      },
      { "mcp-session-id": "sess_engine_live" },
    );
  }
  if (msg.method === "tools/list") return json({ tools: mcpSurface.tools });
  if (msg.method === "tools/call" && mcpSurface.call) {
    mcpToolCalls++;
    return json(
      capture.bodies.length === mcpSurface.call.steps
        ? mcpSurface.call.result
        : { content: [{ type: "text", text: "Document not ready yet." }] },
    );
  }
  return json({});
}

/** The connector call the stub drives on provider request `step`, if it drives one. */
function connectorCall(step: number) {
  const call = mcpSurface.call && step <= mcpSurface.call.steps ? mcpSurface.call : undefined;
  return (
    call && {
      id: `call_connector_${step}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    }
  );
}
type ConnectorCall = NonNullable<ReturnType<typeof connectorCall>>;

/** An OpenAI chat-completions SSE stream: role, text or a tool call, stop + usage. */
function openAiSse(call?: ConnectorCall): Response {
  const chunk = (delta: unknown, extra = "") =>
    `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":null}]${extra}}\n\n`;
  const body = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      }
    : { content: ANSWER };
  const frames =
    chunk({ role: "assistant" }) +
    chunk(body) +
    `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"${call ? "tool_calls" : "stop"}"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** An Anthropic Messages SSE stream: one text or tool_use block, its stop reason + usage. */
function anthropicSse(call?: ConnectorCall): Response {
  const block = call
    ? [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: call.arguments },
        },
      ]
    : [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
      ];
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: call ? "tool_use" : "end_turn" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const capture: Capture = { authHeaders: [], bodies: [] };

/**
 * When set, the provider stub PARKS the completions request instead of
 * answering it, and reports whether the client end was torn down. That is the
 * only externally visible consequence of the engine's `typedSession.abort()`:
 * a stop unblocks the engine's own await either way, so only the upstream
 * request going away distinguishes "the Pi loop was stopped" from "the Pi loop
 * is still running with nobody listening".
 *
 * Module-level and reset in `afterEach`, for the same reason `mcpInitGate` is:
 * a parked request left armed would hang every later turn in this file.
 */
let providerPark: {
  /** Called once the completions request has landed (session is constructed). */
  arrived: () => void;
  /** Resolves true if the client aborted, false if the stub gave up waiting. */
  settle: (clientAborted: boolean) => void;
} | null = null;

/** How long the parked request waits for a teardown before reporting none. */
const PARK_GIVE_UP_MS = 3_000;

/** An error the provider stub answers instead of a completion. */
interface ProviderError {
  status: number;
  message: string;
  type: string;
}
const AUTH_REFUSAL: ProviderError = {
  status: 401,
  message: "Authentication Fails",
  type: "authentication_error",
};
/**
 * When set, the provider stub answers request `n` (1-based, every API) with the error it returns,
 * and with a completion when it returns none. Reset in `afterEach`.
 */
let providerRefusal: ((body: string, n: number) => ProviderError | undefined) | null = null;

function refused(body: string): Response | undefined {
  const error = providerRefusal?.(body, capture.bodies.length);
  return (
    error &&
    Response.json({ error: { message: error.message, type: error.type } }, { status: error.status })
  );
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/responses")) {
      capture.authHeaders.push(req.headers.get("authorization") ?? "");
      capture.bodies.push(await req.text());
      const refusal = refused(capture.bodies.at(-1)!);
      if (refusal) return refusal;
      const step = capture.bodies.length;
      const call = connectorCall(step);
      const item = call && {
        type: "function_call",
        id: `fc_connector_${step}`,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      };
      const events = [
        ...(item
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: 0,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
            ]
          : []),
        {
          type: "response.completed",
          response: { id: "resp_1", status: "completed", output: item ? [item] : [] },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (path.endsWith("/chat/completions")) {
      capture.authHeaders.push(req.headers.get("authorization") ?? "");
      capture.bodies.push(await req.text());
      const refusal = refused(capture.bodies.at(-1)!);
      if (refusal) return refusal;
      if (!providerPark) return openAiSse(connectorCall(capture.bodies.length));
      const park = providerPark;
      park.arrived();
      return new Promise<Response>((resolve) => {
        const giveUp = setTimeout(() => {
          park.settle(false);
          resolve(openAiSse());
        }, PARK_GIVE_UP_MS);
        req.signal.addEventListener("abort", () => {
          clearTimeout(giveUp);
          park.settle(true);
          resolve(new Response(null, { status: 499 }));
        });
      });
    }
    if (path.endsWith("/v1/messages")) {
      capture.authHeaders.push(req.headers.get("authorization") ?? "");
      capture.bodies.push(await req.text());
      const refusal = refused(capture.bodies.at(-1)!);
      if (refusal) return refusal;
      return anthropicSse(connectorCall(capture.bodies.length));
    }
    if (path.startsWith("/api/mcp/")) return mcpResponse(req);
    return new Response("unexpected: " + path, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));
afterEach(() => {
  mcpInitGate = null;
  providerPark = null;
  providerRefusal = null;
  mcpToolCalls = 0;
  mcpSurface = EMPTY_SURFACE;
});

const MODEL_ERROR_LOG = "chat turn failed on a model error";

/** Run `act` with `logger.warn` / `logger.error` recorded instead of written. */
async function recordingWarnAndError<T>(act: () => Promise<T>) {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    return { result: await act(), warn: [...warn.mock.calls], error: [...error.mock.calls] };
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

function orgModel(): OrgModel {
  return {
    id: "preset_live",
    modelId: "upstream-model-must-stay-behind-proxy",
    apiShape: "openai-completions",
    providerId: "openai",
    pi_provider: "openai",
    pi_dialect: null,
    label: "Live engine test model",
    enabled: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4_096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

function userTurn(text: string): UIMessage[] {
  return [{ id: "u1", role: "user", parts: [{ type: "text", text }] }];
}

/** Drive one real turn and collect its UI-message-stream chunks. */
async function runTurn(
  mintBearer: () => string,
  abortSignal?: AbortSignal,
  platformFetch?: typeof fetch,
  turn: {
    model?: OrgModel;
    generation?: PiChatInput["generation"];
    messages?: UIMessage[];
    readAttachment?: PiChatInput["readAttachment"];
    surfaceKey?: string;
    requestId?: string;
  } = {},
) {
  const binding = createPiProxyModelBinding({
    model: turn.model ?? orgModel(),
    origin: ORIGIN,
    mintBearer,
  })!;
  const slot = acquirePiChatSlot();
  expect(slot).not.toBeNull();

  const usage: ChatUsageRecord[] = [];
  // The slot lives in module-global state SHARED with every other test file in
  // this process. A throw between acquire and drain would leave `active`
  // permanently incremented and silently skew the capacity suites, so the
  // release is structural rather than trusted to the happy path.
  try {
    const res = runPiChat({
      slot: slot!,
      modelBinding: binding,
      presetId: "preset_live",
      modelLabel: LIVE_MODEL_LABEL,
      orgId: "org_live",
      userId: "user_live",
      chatSessionId: null,
      ...(turn.requestId ? { requestId: turn.requestId } : {}),
      messages: turn.messages ?? userTurn("dis bonjour"),
      readAttachment: turn.readAttachment,
      system: "You are a helpful assistant.",
      generation: turn.generation ?? {},
      platformMcp: {
        url: `${ORIGIN}/api/mcp/o/org_live?renders_cards=true`,
        headers: {},
        organization: LIVE_ORGANIZATION,
        ...(platformFetch ? { fetch: platformFetch } : {}),
        ...(turn.surfaceKey ? { surfaceKey: turn.surfaceKey } : {}),
      },
      abortSignal: abortSignal ?? new AbortController().signal,
      onError: (error) => String(error),
      recordUsage: (record) => usage.push(record),
    });

    const text = await res.text();
    const chunks: Array<{ type: string; [k: string]: unknown }> = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") chunks.push(JSON.parse(data));
    }
    return { chunks, usage };
  } finally {
    // Idempotent: `releaseOnClose` already fired on the nominal path.
    slot!.release();
  }
}

describe("runPiChat against a stub provider", () => {
  it("streams a full turn, mints a fresh bearer, bills nothing inline, frees the slot", async () => {
    capture.authHeaders.length = 0;
    capture.bodies.length = 0;
    let minted = 0;
    const { chunks, usage } = await runTurn(() => `loopback-${++minted}`);

    // (1) The client contract: a start, visible text, a finish, no error chunk.
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types).toContain("finish");
    expect(types.filter((t) => t === "error")).toEqual([]);
    const streamed = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");
    expect(streamed).toContain(ANSWER);

    // (2) The provider request actually happened, and its Authorization is the
    // freshly minted loopback bearer — NOT the inert `proxy` runtime key, which
    // must never reach the wire in any header or in the body.
    expect(capture.authHeaders.length).toBeGreaterThan(0);
    expect(capture.authHeaders[0]).toBe("Bearer loopback-1");
    expect(minted).toBeGreaterThan(0);
    for (const header of capture.authHeaders) expect(header).not.toContain("proxy");

    // (3) llm-proxy resolves the preset and owns metering: the wire carries the
    // Appstrate preset id, never the upstream model id, and the engine records
    // no inline usage row (one would double-bill).
    const body = JSON.parse(capture.bodies[0]!) as { model?: string };
    expect(body.model).toBe("preset_live");
    expect(capture.bodies[0]).not.toContain("upstream-model-must-stay-behind-proxy");
    expect(usage).toEqual([]);

    // (4) The slot was released when the response stream drained. `release()` is
    // idempotent, so a second call proving nothing — assert via capacity instead.
    const reacquired = acquirePiChatSlot();
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  }, 30_000);

  const pdfBytes = new TextEncoder().encode("%PDF-1.7\nA native document");
  const pdfData = Buffer.from(pdfBytes).toString("base64");
  type WireItem = { role?: string; content?: unknown };
  type Body = { input?: WireItem[]; messages?: WireItem[] };
  const lastUser = (items: WireItem[] | undefined) =>
    items!.findLast((item) => item.role === "user")!.content;
  const PDF_WIRES = [
    {
      apiShape: "openai-responses",
      piProvider: "openai",
      prompt: (body: Body) => lastUser(body.input),
      attached: {
        type: "input_file",
        filename: "contract.pdf",
        file_data: `data:application/pdf;base64,${pdfData}`,
      },
    },
    {
      apiShape: "anthropic-messages",
      piProvider: "anthropic",
      prompt: (body: Body) => lastUser(body.messages),
      attached: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdfData },
        // pi-ai's cache mark moves from the stripped reference to the document, the last block.
        cache_control: { type: "ephemeral" },
      },
    },
    {
      apiShape: "openai-completions",
      piProvider: "openai",
      prompt: (body: Body) => lastUser(body.messages),
      attached: {
        type: "file",
        file: { filename: "contract.pdf", file_data: `data:application/pdf;base64,${pdfData}` },
      },
    },
  ] as const;

  it.each(PDF_WIRES)(
    "sends a current PDF inside the $apiShape user message through the existing bearer",
    async ({ apiShape, piProvider, prompt, attached }) => {
      capture.bodies.length = 0;
      capture.authHeaders.length = 0;
      const messages = userTurn("Read this document");
      messages[0]!.parts.push({
        type: "file",
        filename: "contract.pdf",
        mediaType: "application/pdf",
        url: "appfile://file_live_pdf",
      });
      const readAttachment = mock(async () => ({ mime: "application/pdf", bytes: pdfBytes }));
      const { chunks, usage } = await runTurn(() => "pdf-bearer", undefined, undefined, {
        model: { ...orgModel(), apiShape, pi_provider: piProvider, input: ["text", "image"] },
        messages,
        readAttachment,
      });
      expect(readAttachment).toHaveBeenCalledTimes(1);
      expect(capture.authHeaders).toEqual(["Bearer pdf-bearer"]);
      expect(prompt(JSON.parse(capture.bodies[0]!))).toContainEqual(attached);
      expect(capture.bodies[0]).not.toContain("[pdf:");
      expect(JSON.stringify(chunks)).not.toContain(pdfData);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(usage).toEqual([]);
    },
    30_000,
  );

  /** A connector call answered on step 1 with `resources` (plus a status line). */
  function connectorSurface(resources: { mimeType: string; blob: string }[]): StubSurface {
    const name = "call_integration_tool";
    return {
      tools: [
        {
          name,
          inputSchema: {
            type: "object",
            properties: { tool: { type: "string" }, arguments: { type: "object" } },
          },
        },
      ],
      call: {
        name,
        arguments: { tool: "crm__api_call", arguments: { read_as_file: true } },
        steps: 1,
        result: {
          content: [
            { type: "text", text: '{"results":[{"status":200}]}' },
            ...resources.map((resource, i) => ({
              type: "resource",
              resource: { uri: `urn:uuid:document-${i}`, ...resource },
            })),
          ],
        },
      },
    };
  }

  const toolPdfData = btoa("%PDF-1.7 connector-only file");
  const pdfResource = { mimeType: "application/pdf", blob: toolPdfData };
  const toolPdfUrl = `data:application/pdf;base64,${toolPdfData}`;

  it.each([
    {
      apiShape: "anthropic-messages",
      piProvider: "anthropic",
      // pi-ai merges the step's results into one user message of tool_result blocks.
      toolPart: (body: Body) =>
        (lastUser(body.messages) as { type: string; tool_use_id: string; content: unknown }[]).find(
          (block) => block.type === "tool_result" && block.tool_use_id === "call_connector_1",
        ),
      expected: (part: unknown) =>
        expect(part).toMatchObject({
          content: expect.arrayContaining([
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: toolPdfData },
            },
          ]),
          // pi-ai's cache mark stays on the last block of the last message.
          cache_control: { type: "ephemeral" },
        }),
    },
    {
      apiShape: "openai-completions",
      piProvider: "openai",
      // Tool messages are text only: the PDF follows them in a user message.
      toolPart: (body: Body) => {
        const at = body.messages!.findIndex(
          (item) => item.role === "tool" && JSON.stringify(item).includes("call_connector_1"),
        );
        expect(JSON.stringify(body.messages![at])).not.toContain(toolPdfData);
        return body.messages![at + 1];
      },
      expected: (part: unknown) =>
        expect(part).toEqual({
          role: "user",
          content: [
            { type: "text", text: "Attached PDF(s) from tool result:" },
            { type: "file", file: { filename: "document.pdf", file_data: toolPdfUrl } },
          ],
        }),
    },
  ] as const)(
    "sends a connector PDF on the $apiShape wire in the next provider request",
    async ({ apiShape, piProvider, toolPart, expected }) => {
      capture.bodies.length = 0;
      mcpSurface = connectorSurface([pdfResource]);
      const { chunks } = await runTurn(() => "tool-read", undefined, undefined, {
        model: { ...orgModel(), apiShape, pi_provider: piProvider, input: ["text", "image"] },
      });
      expect(capture.bodies).toHaveLength(2);
      expect(capture.bodies[0]).not.toContain(toolPdfData);
      expect(capture.bodies[1]).not.toContain("[pdf:");
      expected(toolPart(JSON.parse(capture.bodies[1]!)));
      expect(JSON.stringify(chunks)).not.toContain(toolPdfData);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    },
    30_000,
  );

  it("adds a connector PDF to pi-ai's own tool image message on Chat Completions", async () => {
    capture.bodies.length = 0;
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    mcpSurface = connectorSurface([{ mimeType: "image/png", blob: png }, pdfResource]);
    await runTurn(() => "tool-read", undefined, undefined, {
      model: { ...orgModel(), input: ["text", "image"] },
    });
    const messages = (JSON.parse(capture.bodies[1]!) as Body).messages!;
    const at = messages.findIndex((item) => item.role === "tool");
    // pi-ai writes this caption: renamed, the PDF gets a message of its own and this fails.
    expect(messages[at + 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
        { type: "file", file: { filename: "document.pdf", file_data: toolPdfUrl } },
      ],
    });
    expect(messages.slice(at + 2).some((item) => item.role === "user")).toBe(false);
  }, 30_000);

  it.each([1, CHAT_TOOL_STEP_BUDGET])(
    "sends a connector PDF received on tool step %i in the next provider request, with only its receipt on SSE",
    async (steps) => {
      capture.bodies.length = 0;
      const name = "call_integration_tool";
      const data = btoa("%PDF-1.7 connector-only file");
      const args = {
        tool: "crm__api_call",
        arguments: {
          read_as_file: true,
          requests: [{ method: "GET", target: "https://example.test/contract" }],
        },
      };
      mcpSurface = {
        tools: [
          {
            name,
            inputSchema: {
              type: "object",
              properties: { tool: { type: "string" }, arguments: { type: "object" } },
            },
          },
        ],
        call: {
          name,
          arguments: args,
          steps,
          result: {
            content: [
              { type: "text", text: '{"results":[{"status":200}]}' },
              {
                type: "resource",
                resource: { uri: "urn:uuid:document", mimeType: "application/pdf", blob: data },
              },
            ],
          },
        },
      };
      const { chunks } = await runTurn(() => "tool-read", undefined, undefined, {
        model: { ...orgModel(), apiShape: "openai-responses", input: ["text", "image"] },
      });
      expect(capture.bodies).toHaveLength(steps + 1);
      expect(capture.bodies.slice(0, steps).some((body) => body.includes(data))).toBe(false);
      const last = JSON.parse(capture.bodies.at(-1)!);
      if (steps === CHAT_TOOL_STEP_BUDGET) {
        expect(last.input.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "input_text", text: CHAT_FINAL_STEP_SYSTEM_PROMPT }],
        });
      }
      const output = last.input.find(
        (item: { type?: string; call_id?: string }) =>
          item.type === "function_call_output" && item.call_id === `call_connector_${steps}`,
      );
      expect(output.output).toContainEqual({
        type: "input_file",
        filename: "document.pdf",
        file_data: `data:application/pdf;base64,${data}`,
      });
      expect(chunks.find((chunk) => chunk.type === "tool-input-available")?.input).toEqual(args);
      const receipt = chunks.findLast((chunk) => chunk.type === "tool-output-available");
      expect(JSON.stringify(receipt?.output)).toContain("application/pdf");
      expect(JSON.stringify(chunks)).not.toContain(data);
    },
    30_000,
  );

  it("sends real image pixels unless the model is declared text-only, unknown modalities included", async () => {
    const messages = userTurn("Read this image");
    messages[0]!.parts.push({
      type: "file",
      filename: "pixel.png",
      mediaType: "image/png",
      url: "appfile://file_live_image",
    });
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const readAttachment = mock(async () => ({ mime: "image/png", bytes }));
    const cases: [OrgModel["input"], boolean][] = [
      [["text", "image"], true],
      [null, true],
      [["text"], false],
    ];
    for (const [input, sent] of cases) {
      capture.bodies.length = 0;
      const { chunks } = await runTurn(() => "image-bearer", undefined, undefined, {
        model: { ...orgModel(), input },
        messages,
        readAttachment,
      });
      const body = capture.bodies[0]!;
      expect(body).toContain("appfile://file_live_image");
      expect(body.includes("data:image/png;base64,")).toBe(sent);
      expect(body).not.toContain("image omitted");
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    }
    expect(readAttachment).toHaveBeenCalledTimes(2);
  }, 30_000);

  describe("a file the model refuses", () => {
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const IMAGE_POINTER = "[image withheld: this model rejected it; any other file was delivered]";
    const PDF_POINTER = "[PDF withheld: this model rejected it; any other file was delivered]";
    const WITHHELD_LOG = "chat turn withheld a file the model refused";
    // DeepSeek's answer to a PDF part on Chat Completions.
    const FILE_REFUSAL: ProviderError = {
      status: 400,
      message: "file must have a file_id or file_data",
      type: "invalid_request_error",
    };
    /** Refuses every request carrying one of `data`. */
    const refusing =
      (...data: string[]) =>
      (body: string) =>
        data.some((d) => body.includes(d)) ? FILE_REFUSAL : undefined;
    const vision = (apiShape: OrgModel["apiShape"] = "openai-completions"): OrgModel => ({
      ...orgModel(),
      apiShape,
      pi_provider: apiShape === "anthropic-messages" ? "anthropic" : "openai",
      input: ["text", "image"],
    });

    /** A user message attaching one file of each kind named. */
    function attaching(...kinds: ("image" | "pdf")[]): UIMessage[] {
      const messages = userTurn("Read these files");
      for (const kind of kinds) {
        messages[0]!.parts.push(
          kind === "image"
            ? {
                type: "file",
                filename: "pixel.png",
                mediaType: "image/png",
                url: "appfile://file_live_image",
              }
            : {
                type: "file",
                filename: "contract.pdf",
                mediaType: "application/pdf",
                url: "appfile://file_live_pdf",
              },
        );
      }
      return messages;
    }
    const readFiles: PiChatInput["readAttachment"] = async (uri) =>
      uri.endsWith("image")
        ? { mime: "image/png", bytes: Buffer.from(PNG, "base64") }
        : { mime: "application/pdf", bytes: pdfBytes };
    const answered = (chunks: Awaited<ReturnType<typeof runTurn>>["chunks"]) =>
      chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta?: string }).delta)
        .join("");
    const finishTurn = (chunks: Awaited<ReturnType<typeof runTurn>>["chunks"]) =>
      (
        chunks.find((c) => c.type === "finish") as {
          messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
        }
      ).messageMetadata?.appstrate?.turn;

    it("replays a PDF refused on Chat Completions once without it, and the turn answers", async () => {
      capture.bodies.length = 0;
      providerRefusal = refusing(pdfData);
      const { result, warn } = await recordingWarnAndError(() =>
        runTurn(() => "pdf-refused", undefined, undefined, {
          model: vision(),
          messages: attaching("pdf"),
          readAttachment: readFiles,
        }),
      );
      expect(capture.bodies).toHaveLength(2);
      expect(capture.bodies[0]).toContain(pdfData);
      expect(capture.bodies[1]).not.toContain(pdfData);
      expect(capture.bodies[1]).toContain(PDF_POINTER);
      // The failed attempt is forgotten: no error reaches the client, the turn ends as a stop.
      expect(result.chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(answered(result.chunks)).toContain(ANSWER);
      expect(finishTurn(result.chunks)).toMatchObject({ finishReason: "stop" });
      expect(JSON.stringify(finishTurn(result.chunks))).not.toContain("errorCategory");
      expect(warn.filter(([msg]) => msg === MODEL_ERROR_LOG)).toEqual([]);
      const logged = warn.filter(([msg]) => msg === WITHHELD_LOG);
      expect(logged).toHaveLength(1);
      expect(logged[0]![1]).toEqual({
        orgId: "org_live",
        presetId: "preset_live",
        chatSessionId: null,
        api: "openai-completions",
        kinds: ["pdf"],
      });
    }, 30_000);

    it("keeps the image when only the PDF beside it is refused", async () => {
      capture.bodies.length = 0;
      providerRefusal = refusing(pdfData);
      const { chunks } = await runTurn(() => "pdf-refused", undefined, undefined, {
        model: vision(),
        messages: attaching("image", "pdf"),
        readAttachment: readFiles,
      });
      expect(capture.bodies).toHaveLength(2);
      expect(capture.bodies[0]).toContain(PNG);
      expect(capture.bodies[1]).toContain(PNG);
      expect(capture.bodies[1]).toContain(PDF_POINTER);
      expect(capture.bodies[1]).not.toContain(pdfData);
      expect(capture.bodies[1]).not.toContain(IMAGE_POINTER);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    }, 30_000);

    const TEXT_TYPES = [
      { apiShape: "openai-completions", textType: "text" },
      { apiShape: "anthropic-messages", textType: "text" },
      { apiShape: "openai-responses", textType: "input_text" },
    ] as const;

    it.each(TEXT_TYPES)(
      "withholds the PDF, then the image too, of a $apiShape user message",
      async ({ apiShape, textType }) => {
        capture.bodies.length = 0;
        providerRefusal = refusing(pdfData, PNG);
        const { chunks } = await runTurn(() => "both-refused", undefined, undefined, {
          model: vision(apiShape),
          messages: attaching("image", "pdf"),
          readAttachment: readFiles,
        });
        expect(capture.bodies).toHaveLength(3);
        expect(capture.bodies[0]).toContain(pdfData);
        expect(capture.bodies[0]).toContain(PNG);
        expect(capture.bodies[1]).toContain(PNG);
        expect(capture.bodies[1]).not.toContain(pdfData);
        const last = capture.bodies[2]!;
        expect(last).not.toContain(PNG);
        expect(last).not.toContain(pdfData);
        for (const pointer of [IMAGE_POINTER, PDF_POINTER]) {
          expect(last).toContain(JSON.stringify({ type: textType, text: pointer }).slice(1, -1));
        }
        expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
        expect(finishTurn(chunks)).toMatchObject({ finishReason: "stop" });
      },
      30_000,
    );

    it.each(TEXT_TYPES)(
      "replays a $apiShape step refused for a tool's files without running the tool again",
      async ({ apiShape }) => {
        capture.bodies.length = 0;
        mcpSurface = connectorSurface([{ mimeType: "image/png", blob: PNG }, pdfResource]);
        providerRefusal = refusing(toolPdfData, PNG);
        const { chunks } = await runTurn(() => "tool-refused", undefined, undefined, {
          model: vision(apiShape),
        });
        // Step 1 calls the tool, step 2 carries its files and is refused, its replays answer.
        expect(mcpToolCalls).toBe(1);
        expect(chunks.filter((chunk) => chunk.type === "tool-input-available")).toHaveLength(1);
        expect(capture.bodies).toHaveLength(4);
        expect(capture.bodies[1]).toContain(toolPdfData);
        expect(capture.bodies[1]).toContain(PNG);
        expect(capture.bodies[2]).toContain(PNG);
        expect(capture.bodies[2]).not.toContain(toolPdfData);
        expect(capture.bodies[2]).toContain(PDF_POINTER);
        // The withheld PDF is not also claimed as delivered beside its pointer.
        expect(capture.bodies.some((body) => body.includes("PDF supplied"))).toBe(false);
        expect(capture.bodies[3]).not.toContain(PNG);
        expect(capture.bodies[3]).toContain(IMAGE_POINTER);
        expect(capture.bodies[3]).toContain(PDF_POINTER);
        expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
        expect(finishTurn(chunks)).toMatchObject({ finishReason: "stop" });
      },
      30_000,
    );

    it("keeps the first error when every replay is refused the same way", async () => {
      capture.bodies.length = 0;
      providerRefusal = (_body, n) => ({
        ...FILE_REFUSAL,
        message: `Unsupported parameter: 'temperature' is not supported with this model. (#${n})`,
      });
      const { result, warn } = await recordingWarnAndError(() =>
        runTurn(() => "non-file-4xx", undefined, undefined, {
          model: vision(),
          messages: attaching("image", "pdf"),
          readAttachment: readFiles,
        }),
      );
      // The PDF-less replay, the file-less one, then the first error stands.
      expect(capture.bodies).toHaveLength(3);
      expect(capture.bodies[2]).not.toContain(PNG);
      expect(capture.bodies[2]).not.toContain(pdfData);
      expect(result.chunks.find((c) => c.type === "error")?.errorText).toBe(
        "appstrate:chat-turn-error:invalid_request",
      );
      expect(finishTurn(result.chunks)).toMatchObject({
        finishReason: "error",
        errorCategory: "invalid_request",
      });
      const logged = warn.find(([msg]) => msg === MODEL_ERROR_LOG)?.[1] as { err?: string };
      expect(logged.err).toContain("(#1)");
      expect(warn.filter(([msg]) => msg === WITHHELD_LOG)).toEqual([]);
    }, 30_000);

    it("ends a turn stopped during the replay as a stop, not as the refused attempt's error", async () => {
      capture.bodies.length = 0;
      providerRefusal = refusing(pdfData);
      let arrived!: () => void;
      const replayArrived = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      providerPark = { arrived, settle: () => {} };
      const stopped = new AbortController();
      const logs = await recordingWarnAndError(async () => {
        const turn = runTurn(() => "stop-during-replay", stopped.signal, undefined, {
          model: vision(),
          messages: attaching("pdf"),
          readAttachment: readFiles,
        });
        await replayArrived;
        stopped.abort(new Error("stopped by user"));
        return turn;
      });
      expect(capture.bodies).toHaveLength(2);
      expect(logs.warn.filter(([msg]) => msg === MODEL_ERROR_LOG)).toEqual([]);
      expect(logs.warn.filter(([msg]) => msg === WITHHELD_LOG)).toEqual([]);
      const { chunks } = logs.result;
      expect(chunks.map((c) => c.type)).not.toContain("error");
      expect(JSON.stringify(finishTurn(chunks))).not.toContain("errorCategory");
    }, 30_000);

    it("lets Pi retry a replay that hits a 503", async () => {
      capture.bodies.length = 0;
      providerRefusal = (body, n) =>
        n === 2
          ? { status: 503, message: "Service unavailable", type: "server_error" }
          : refusing(pdfData)(body);
      const { chunks } = await runTurn(() => "replay-503", undefined, undefined, {
        model: vision(),
        messages: attaching("pdf"),
        readAttachment: readFiles,
      });
      expect(capture.bodies.length).toBeGreaterThanOrEqual(3);
      expect(capture.bodies[0]).toContain(pdfData);
      for (const body of capture.bodies.slice(1)) {
        expect(body).not.toContain(pdfData);
        expect(body).toContain(PDF_POINTER);
      }
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(answered(chunks)).toContain(ANSWER);
    }, 30_000);

    it("keeps withholding the refused kind on the later steps of the turn", async () => {
      capture.bodies.length = 0;
      const surface = connectorSurface([]);
      // The replay (request 2) calls the tool; request 3 answers.
      mcpSurface = { ...surface, call: { ...surface.call!, steps: 2 } };
      providerRefusal = refusing(pdfData);
      const { chunks } = await runTurn(() => "later-step", undefined, undefined, {
        model: vision(),
        messages: attaching("pdf"),
        readAttachment: readFiles,
      });
      expect(mcpToolCalls).toBe(1);
      expect(capture.bodies).toHaveLength(3);
      expect(capture.bodies[2]).not.toContain(pdfData);
      expect(capture.bodies[2]).toContain(PDF_POINTER);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(answered(chunks)).toContain(ANSWER);
    }, 30_000);

    it("replays without a refused image a model of unknown modalities was sent", async () => {
      capture.bodies.length = 0;
      providerRefusal = refusing(PNG);
      const { chunks } = await runTurn(() => "unknown-modalities", undefined, undefined, {
        model: { ...orgModel(), input: null },
        messages: attaching("image"),
        readAttachment: readFiles,
      });
      expect(capture.bodies).toHaveLength(2);
      expect(capture.bodies[0]).toContain(PNG);
      expect(capture.bodies[1]).not.toContain(PNG);
      expect(capture.bodies[1]).toContain(IMAGE_POINTER);
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(answered(chunks)).toContain(ANSWER);
    }, 30_000);
  });

  it("sends an alias's public level as its backing's nearest", async () => {
    // The loopback listing is unprojected: the binding carries the backing
    // (deepseek-flash: off/low/high/max), which Pi's session clamps to.
    capture.bodies.length = 0;
    const alias: OrgModel = {
      ...orgModel(),
      modelId: "deepseek-flash",
      providerId: "deepseek",
      pi_provider: "deepseek",
      // As the listing resolves them off the record: its dialect and its reasoning.
      pi_dialect: piModelDialect(getPiModel("deepseek", "deepseek-flash", "openai-completions")!),
      reasoning: true,
    };
    await runTurn(() => "bearer", undefined, undefined, {
      model: alias,
      generation: { reasoning_level: "medium" },
    });
    expect(JSON.parse(capture.bodies[0]!)).toMatchObject({ reasoning_effort: "high" });
  }, 30_000);

  it("mints a NEW bearer per provider request rather than reusing one", async () => {
    // The guard against the 60 s loopback token outliving a multi-step turn. If
    // the auth extension were dropped, the header would be the inert runtime
    // key and this assertion fails — the test can fail, which is the point.
    capture.authHeaders.length = 0;
    capture.bodies.length = 0;
    let minted = 0;
    await runTurn(() => `fresh-${++minted}`);

    expect(capture.authHeaders.length).toBe(minted);
    expect(new Set(capture.authHeaders).size).toBe(capture.authHeaders.length);
    expect(capture.authHeaders.every((h) => h.startsWith("Bearer fresh-"))).toBe(true);
  }, 30_000);

  it("closes a stopped turn as a plain stop, with no error chunk", async () => {
    // The engine's OUTER catch is the only place the abort suppression lives:
    //
    //     ...(aborted ? {} : { error: err }),
    //     finishReason: aborted ? "stop" : "error",
    //
    // `closePiTurn` itself does not suppress anything — hand it an error and it
    // emits an `error` chunk whatever `aborted` says (asserted in
    // `pi-chat-turn-closure.test.ts`). So this decision is only reachable
    // through the engine, and only on the exit where an exception escapes with
    // the turn already aborted: a stop that lands during setup, before the
    // prompt's own try/catch exists to swallow it. Aborting the signal up front
    // is exactly that shape — `buildPlatformMcpTools` is the first await and it
    // throws on an already-aborted signal.
    //
    // Delete the suppression and this fails twice over: an `error` chunk
    // appears in the stream, and the persisted metadata gains an
    // `errorCategory` — a user pressing stop would be shown a failed turn.
    const stopped = new AbortController();
    stopped.abort(new Error("stopped by user"));
    const { chunks } = await runTurn(() => "unused", stopped.signal);

    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    const finish = chunks.find((c) => c.type === "finish") as {
      messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
    };
    expect(finish.messageMetadata?.appstrate?.turn?.finishReason).toBe("stop");
    // Nothing about the abort is persisted as a failure: no category, no
    // retryable flag, no request id.
    expect(finish.messageMetadata?.appstrate?.turn).not.toHaveProperty("errorCategory");
    expect(JSON.stringify(chunks)).not.toContain("errorCategory");
  }, 30_000);

  it("stamps the bound model on the finish of BOTH engine exits", async () => {
    // `closePiTurn` only copies what it is handed (`pi-chat-turn-closure.test.ts`);
    // what only the engine can show is that each of its two exits hands it the
    // turn's model. The loop-returned exit is a normal turn; the escaped-
    // exception exit is a stop that lands during setup (see the test above).
    const finishTurn = (chunks: Array<{ type: string; [k: string]: unknown }>) =>
      (
        chunks.find((c) => c.type === "finish") as {
          messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
        }
      ).messageMetadata?.appstrate?.turn;

    const completed = await runTurn(() => "loopback-model");
    expect(finishTurn(completed.chunks)).toMatchObject({
      finishReason: "stop",
      modelId: "preset_live",
      modelLabel: LIVE_MODEL_LABEL,
    });

    const stopped = new AbortController();
    stopped.abort(new Error("stopped by user"));
    const escaped = await runTurn(() => "unused", stopped.signal);
    expect(finishTurn(escaped.chunks)).toMatchObject({
      finishReason: "stop",
      modelId: "preset_live",
      modelLabel: LIVE_MODEL_LABEL,
    });
  }, 30_000);

  it("logs a turn the provider refused once, at warn, with the raw cause", async () => {
    // The stream carries the category alone, and the persistence drain ignores
    // that marker: this line is the only place the provider's answer is kept.
    providerRefusal = () => AUTH_REFUSAL;
    const logs = await recordingWarnAndError(() => runTurn(() => "loopback-refused"));

    const errorChunk = logs.result.chunks.find((c) => c.type === "error");
    expect(errorChunk?.errorText).toBe("appstrate:chat-turn-error:credential_unavailable");
    const lines = logs.warn.filter(([msg]) => msg === MODEL_ERROR_LOG);
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toMatchObject({
      chatSessionId: null,
      orgId: "org_live",
      presetId: "preset_live",
      category: "credential_unavailable",
    });
    expect(String((lines[0]![1] as { err: unknown }).err)).toContain("401");
    expect(logs.error).toEqual([]);
  }, 30_000);

  it("logs a provider-reported failure under the request id the user is shown", async () => {
    // The commonest failure: the provider answers with an error, the loop
    // returns, nothing throws. The id on the turn is only worth showing if a
    // server log line carries it — with the cause the client never sees.
    providerRefusal = () => AUTH_REFUSAL;
    const logged: Array<Record<string, unknown>> = [];
    const spy = (msg: string, data?: Record<string, unknown>) => void logged.push({ msg, ...data });
    const original = { warn: logger.warn, error: logger.error };
    logger.warn = spy as unknown as typeof logger.warn;
    logger.error = spy as unknown as typeof logger.error;
    let chunks: Awaited<ReturnType<typeof runTurn>>["chunks"];
    try {
      ({ chunks } = await runTurn(() => "loopback-refused", undefined, undefined, {
        requestId: "req_turn1",
      }));
    } finally {
      Object.assign(logger, original);
    }

    const turn = (
      chunks.find((c) => c.type === "finish") as {
        messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
      }
    ).messageMetadata?.appstrate?.turn;
    expect(turn).toMatchObject({
      finishReason: "error",
      errorCategory: "credential_unavailable",
      requestId: "req_turn1",
    });
    expect(chunks.find((c) => c.type === "error")).toMatchObject({
      errorText: "appstrate:chat-turn-error:credential_unavailable:req_turn1",
    });
    const line = logged.find((data) => data.requestId === turn?.requestId);
    expect(line).toMatchObject({
      msg: "chat turn failed on a model error",
      category: "credential_unavailable",
    });
    expect(String(line?.err)).toContain("Authentication Fails");
  }, 30_000);

  it("tears the live Pi session down when a stop lands mid-inference", async () => {
    // The two other stop cases in this file abort during CONSTRUCTION — one up
    // front, one on a wedged MCP handshake — so neither ever reaches
    // `createAgentSession`, and `typedSession.abort()` in the engine's catch
    // was asserted nowhere. Delete it and every one of those cases still
    // passes: the client gets its start/finish envelope, the slot is released
    // on drain, and the Pi loop keeps running against the provider until the
    // turn deadline, billing tokens nobody will ever read.
    //
    // Parking the provider request is what makes that observable. The engine's
    // own await returns on abort either way (`untilAborted` races the signal),
    // so the ONLY difference the outside world can see is whether the upstream
    // request is torn down with the session.
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let settle!: (clientAborted: boolean) => void;
    const providerTornDown = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    providerPark = { arrived, settle };

    const stopped = new AbortController();
    const logs = await recordingWarnAndError(async () => {
      const turn = runTurn(() => "loopback-midflight", stopped.signal);
      // Only press stop once the completions request has actually landed —
      // that is the proof the session exists and the prompt is in flight.
      await requestArrived;
      stopped.abort(new Error("stopped by user"));
      return turn;
    });

    const { chunks } = logs.result;
    expect(await providerTornDown).toBe(true);
    // A stop is not a model error, and not a failure: neither line is written.
    expect(logs.warn.filter(([msg]) => msg === MODEL_ERROR_LOG)).toEqual([]);
    expect(logs.error).toEqual([]);
    // Still a well-formed, non-error turn (same contract as the other stops).
    // The step chunks in between are whatever the model got through before the
    // stop — not pinned here, only the envelope and the absence of an error.
    const types = chunks.map((c) => c.type);
    expect(types.at(0)).toBe("start");
    expect(types.at(-1)).toBe("finish");
    expect(types).not.toContain("error");
  }, 30_000);

  it("opens the stream before the platform-MCP handshake completes", async () => {
    // Hold the handshake open. If the `start` chunk were written after session
    // construction — as it was before — the read below could not return, and
    // this test would time out rather than pass.
    let releaseHandshake!: () => void;
    mcpInitGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });

    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "loopback-early",
    })!;
    const slot = acquirePiChatSlot();
    expect(slot).not.toBeNull();

    try {
      const res = runPiChat({
        slot: slot!,
        modelBinding: binding,
        presetId: "preset_live",
        modelLabel: LIVE_MODEL_LABEL,
        orgId: "org_live",
        userId: "user_live",
        chatSessionId: null,
        messages: userTurn("dis bonjour"),
        system: "You are a helpful assistant.",
        generation: {},
        platformMcp: {
          url: `${ORIGIN}/api/mcp/o/org_live?renders_cards=true`,
          headers: {},
          organization: LIVE_ORGANIZATION,
        },
        abortSignal: new AbortController().signal,
        onError: (error) => String(error),
        recordUsage: () => {},
      });

      // Read only as far as the first complete SSE frame.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let first: { type?: string } | undefined;
      while (!first) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (const line of buffered.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            first = JSON.parse(data) as { type?: string };
            break;
          }
        }
      }

      // The turn is open while the handshake is still blocked.
      expect(first?.type).toBe("start");

      releaseHandshake();
      // Drain so the slot releases and no work outlives the test.
      while (!(await reader.read()).done) {
        /* drain */
      }
    } finally {
      mcpInitGate = null;
      releaseHandshake();
      slot!.release();
    }
  }, 30_000);

  it("releases the slot when a WEDGED platform-MCP handshake is stopped", async () => {
    // The turn's whole CONSTRUCTION phase used to observe nothing: `turnAbort`
    // got its first listener only just before the prompt, ~180 lines after the
    // handshake. A platform MCP that never answers `initialize` (a DB pool
    // exhausted by concurrent runs, a module hook that never settles) therefore
    // parked `execute` forever — `createUIMessageStream` never closed,
    // `releaseOnClose` never ran, and this slot was held for the life of the
    // process. Six such turns exhaust `CHAT_PI_MAX_CONCURRENCY` and every later
    // chat 429s until restart; the user's own `POST …/stop` did nothing, since
    // it sets exactly the controller nobody was listening to.
    //
    // Own timeout, deliberately short: on the unfixed engine this does not
    // fail, it hangs (for the MCP SDK's 60 s default request timeout, which was
    // the only bound that existed).
    let releaseHandshake!: () => void;
    mcpInitGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });

    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "never-minted",
    })!;
    const slot = acquirePiChatSlot();
    expect(slot).not.toBeNull();
    // Counting wrapper: `release()` is idempotent and the capacity counter is
    // shared with every other suite in this process, so "a slot is available"
    // proves nothing here. Observe the call itself.
    let released = 0;
    const counted = {
      release: () => {
        released += 1;
        slot!.release();
      },
    };

    const stopped = new AbortController();
    try {
      const res = runPiChat({
        slot: counted,
        modelBinding: binding,
        presetId: "preset_live",
        modelLabel: LIVE_MODEL_LABEL,
        orgId: "org_live",
        userId: "user_live",
        chatSessionId: null,
        messages: userTurn("dis bonjour"),
        system: "You are a helpful assistant.",
        generation: {},
        platformMcp: {
          url: `${ORIGIN}/api/mcp/o/org_live?renders_cards=true`,
          headers: {},
          organization: LIVE_ORGANIZATION,
        },
        abortSignal: stopped.signal,
        onError: (error) => String(error),
        recordUsage: () => {},
      });

      // Press stop once construction is genuinely parked on the handshake.
      const stopTimer = setTimeout(() => stopped.abort(new Error("stopped by user")), 50);
      const text = await res.text();
      clearTimeout(stopTimer);

      // The stream CLOSED — that is what `releaseOnClose` hangs off.
      expect(released).toBeGreaterThan(0);

      // And it closed as a well-formed turn, not as a bare truncation: the
      // client still needs a start/finish envelope to reconstruct a message.
      const chunks: Array<{ type: string }> = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") chunks.push(JSON.parse(data) as { type: string });
      }
      expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    } finally {
      mcpInitGate = null;
      releaseHandshake();
      slot!.release();
    }
  }, 5_000);

  it("releases the slot when the MCP close never settles", async () => {
    // `await mcpTools?.close()` in the turn's `finally` was the last unbounded
    // await between the producer and its return: a close that never settles
    // holds `execute` open, `createUIMessageStream` never closes, and
    // `releaseOnClose` never frees the slot — the same leak the session-abort
    // bound closed, re-entered one line later. On the unbounded engine this
    // test does not fail, it HANGS: `res.text()` never resolves.
    //
    // A real close always settles, so the real builder is wrapped and only its
    // `close` replaced. The real client is closed by hand at the end so it
    // does not outlive the test.
    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "loopback-close",
    })!;
    let real: Awaited<ReturnType<typeof buildPlatformMcpTools>> | undefined;
    const buildMcpTools: NonNullable<PiChatInput["buildMcpTools"]> = async (opts) => {
      real = await buildPlatformMcpTools(opts);
      return { ...real, close: () => new Promise<void>(() => {}) };
    };

    let released = 0;
    const warnSpy = mock(() => {});
    const originalWarn = logger.warn;
    logger.warn = warnSpy as unknown as typeof logger.warn;
    const startedAt = Date.now();
    try {
      const res = runPiChat({
        slot: {
          release: () => {
            released += 1;
          },
        },
        modelBinding: binding,
        presetId: "preset_live",
        modelLabel: LIVE_MODEL_LABEL,
        orgId: "org_live",
        userId: "user_live",
        chatSessionId: null,
        messages: userTurn("dis bonjour"),
        system: "You are a helpful assistant.",
        generation: {},
        platformMcp: {
          url: `${ORIGIN}/api/mcp/o/org_live?renders_cards=true`,
          headers: {},
          organization: LIVE_ORGANIZATION,
        },
        abortSignal: new AbortController().signal,
        onError: (error) => String(error),
        recordUsage: () => {},
        buildMcpTools,
        // The bound is under test, not its production length.
        windDownGraceMs: 100,
      });
      const text = await res.text();

      // The body closed and the slot went with it, within the grace plus the
      // turn's own construction — far below the 20 s this test allows.
      expect(released).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      // Said so, in the same shape as the session-abort case.
      const warned = warnSpy.mock.calls.map((c) => (c as unknown[])[0]);
      expect(warned).toContain("Pi chat MCP close did not settle — tearing the turn down anyway");
      // And the turn the client got is whole: the wedged close cost it nothing.
      const types = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((d) => d && d !== "[DONE]")
        .map((d) => (JSON.parse(d) as { type: string }).type);
      expect(types.at(0)).toBe("start");
      expect(types.at(-1)).toBe("finish");
      expect(types).toContain("text-delta");
    } finally {
      logger.warn = originalWarn;
      await real?.close();
    }
  }, 20_000);

  it("logs the turn's construction timings once, every phase a number", async () => {
    // Where a turn's fixed cost goes is invisible without this line: the
    // handshake, the SDK import, the projection, the runtime, the loader, the
    // session, and how long the model then took to answer at all. One entry
    // per turn, keyed by session; on the happy path every phase was reached.
    const infoSpy = mock(() => {});
    const originalInfo = logger.info;
    logger.info = infoSpy as unknown as typeof logger.info;
    try {
      await runTurn(() => "loopback-timings");
    } finally {
      logger.info = originalInfo;
    }

    const lines = infoSpy.mock.calls.filter(
      (c) => (c as unknown[])[0] === "chat turn construction",
    );
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as unknown[])[1] as Record<string, unknown>;
    for (const key of [
      "mcpHandshakeMs",
      "sdkLoadMs",
      "projectionMs",
      "runtimeMs",
      "loaderMs",
      "sessionMs",
      "constructionMs",
      "firstModelEventMs",
    ]) {
      expect(typeof fields[key]).toBe("number");
      expect(fields[key] as number).toBeGreaterThanOrEqual(0);
    }
    expect(fields).toHaveProperty("chatSessionId", null);
    // The model's first event comes after the prompt was issued, which comes
    // after construction — the ordering the numbers must reflect.
    expect(fields.firstModelEventMs as number).toBeGreaterThanOrEqual(
      fields.constructionMs as number,
    );
  }, 30_000);

  it("sends the model byte-identical requests from a cached surface, without a handshake", async () => {
    // The cache must be invisible to the model: the server instructions land at
    // the same place in the system prompt and the tools are the same bytes, so
    // the provider's prompt cache hits across the miss → hit boundary.
    mcpSurface = {
      instructions: "Stub platform instructions.\n\n## Operation index\n## Agents\nlistAgents",
      tools: [
        {
          name: "search",
          description: "Search the stub's operations.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    };
    const turn = { surfaceKey: `engine-live:${crypto.randomUUID()}` };
    capture.bodies.length = 0;
    mcpInitializes = 0;

    await runTurn(() => "bearer-miss", undefined, undefined, turn);
    await runTurn(() => "bearer-hit", undefined, undefined, turn);

    expect(mcpInitializes).toBe(1);
    expect(capture.bodies).toHaveLength(2);
    expect(capture.bodies[0]).toContain("Stub platform instructions.");
    expect(capture.bodies[0]).toContain("Search the stub's operations.");
    expect(capture.bodies[1]).toBe(capture.bodies[0]!);
  }, 30_000);

  it("carries the caller's fetch all the way into the MCP transport", async () => {
    // The route→engine hop is asserted in `chat-stream-handler.test.ts`, which
    // probes `input.platformMcp.fetch`. The two hops AFTER it — engine →
    // `buildPlatformMcpTools`, and that → `createMcpHttpClient` — were only
    // ever evaluated on their falsy branch, because every fixture in this file
    // built `platformMcp` without a `fetch`. Dropping the fetch on either hop
    // left the whole suite green while production silently went back to opening
    // real loopback TCP connections per turn — and kept using them for every
    // `tools/call` after the handshake, since the override lives for the
    // client's whole lifetime.
    const seen: string[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push(new Request(input as RequestInfo, init).url);
      return fetch(input as RequestInfo, init);
    };

    const { chunks } = await runTurn(() => "bearer-mcp-fetch", undefined, recording);

    // It reached the transport: the handshake and the tool listing both went
    // through the injected fetch rather than the global one.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.includes("/api/mcp/"))).toBe(true);
    // And the turn still completed, so the injection is not merely observed —
    // it is what actually served the handshake.
    expect(chunks.at(-1)?.type).toBe("finish");
  }, 30_000);
});
