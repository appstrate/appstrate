// SPDX-License-Identifier: Apache-2.0

/**
 * The `openai-responses` llm-proxy adapter (OpenAI Responses API,
 * `POST /v1/responses`) — the wire of the `openai` and `xai` providers.
 *
 * Fixtures are the Responses API's own shapes: a non-streaming `response`
 * object with a top-level `usage`, and an SSE event stream whose usage arrives
 * only in the terminal `response.completed` / `response.incomplete` event's
 * `response.usage`. Usage parity with pi-ai lives in
 * `llm-proxy-usage-parity.test.ts`; the HTTP round-trip in the route-level
 * integration suite.
 */

import { describe, it, expect } from "bun:test";
import { openaiResponsesAdapter } from "../../src/services/llm-proxy/openai-responses.ts";
import {
  forwardMeteredResponse,
  tapSseUsage,
  usageFrameBound,
  type MeteredForwardContext,
  type RecordUsageInputs,
} from "../../src/services/llm-proxy/metering.ts";
import type { ResolvedModel } from "../../src/services/org-models.ts";

const REAL = "gpt-5.1-2025-11-13";

/** One SSE event block, as the Responses API frames it (`event:` + `data:`). */
function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const RESPONSE_SHELL = { id: "resp_1", object: "response", created_at: 1_760_000_000, model: REAL };

const COMPLETED_USAGE = {
  input_tokens: 1_500,
  input_tokens_details: { cached_tokens: 1_024 },
  output_tokens: 320,
  output_tokens_details: { reasoning_tokens: 128 },
  total_tokens: 1_820,
};

function streamEvents(terminal: "response.completed" | "response.incomplete"): string[] {
  return [
    sse("response.created", {
      sequence_number: 0,
      response: { ...RESPONSE_SHELL, status: "in_progress", output: [], usage: null },
    }),
    sse("response.in_progress", {
      sequence_number: 1,
      response: { ...RESPONSE_SHELL, status: "in_progress", output: [], usage: null },
    }),
    sse("response.output_item.added", {
      sequence_number: 2,
      output_index: 0,
      item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
    }),
    sse("response.output_text.delta", {
      sequence_number: 3,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "Bonjour",
    }),
    sse("response.output_text.done", {
      sequence_number: 4,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: "Bonjour",
    }),
    sse(terminal, {
      sequence_number: 5,
      response: {
        ...RESPONSE_SHELL,
        status: terminal === "response.completed" ? "completed" : "incomplete",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Bonjour" }],
          },
        ],
        usage: COMPLETED_USAGE,
      },
    }),
  ];
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** 1 500 input − 1 024 cached = 476 cache-miss input; reasoning ⊂ output. */
const EXPECTED_USAGE = { inputTokens: 476, outputTokens: 320, cacheReadTokens: 1_024 };

function collectUsage() {
  const calls: RecordUsageInputs[] = [];
  return {
    calls,
    recordUsage: async (inputs: RecordUsageInputs) => {
      calls.push(inputs);
    },
  };
}

function makeCtx(): MeteredForwardContext {
  return {
    principal: { kind: "jwt_user", userId: "u", orgId: "o" },
    runId: null,
    chatSessionId: null,
    presetId: "preset",
    resolved: { modelId: REAL, apiShape: "openai-responses" } as unknown as ResolvedModel,
    started: 0,
    requestId: "req_test",
  };
}

const SWAP = {
  alias: "appstrate-large",
  real: REAL,
  clientApiShape: "openai-responses" as const,
  backingApiShape: "openai-responses" as const,
};

/** Resolve once the out-of-band SSE tap has handed its usage to the meter. */
async function untilMetered(calls: RecordUsageInputs[]): Promise<RecordUsageInputs> {
  for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("openaiResponsesAdapter — request side", () => {
  it("serves the openai-responses api shape", () => {
    expect(openaiResponsesAdapter.apiShape).toBe("openai-responses");
  });

  it("injects the upstream key as a bearer and forwards the SDK's headers", () => {
    const headers = openaiResponsesAdapter.buildUpstreamHeaders(
      new Headers({
        authorization: "Bearer appstrate-caller-token",
        "openai-beta": "responses=v1",
        "x-client-request-id": "sess_1",
      }),
      "sk-upstream",
    );
    expect(Object.fromEntries(headers)).toEqual({
      authorization: "Bearer sk-upstream",
      "content-type": "application/json",
      "openai-beta": "responses=v1",
      "x-client-request-id": "sess_1",
    });
  });

  it("adds no usage opt-in: the Responses API always reports usage", () => {
    const body: Record<string, unknown> = { model: REAL, input: "hi", stream: true };
    openaiResponsesAdapter.prepareRequest?.(body);
    expect(body).toEqual({ model: REAL, input: "hi", stream: true, store: false });
  });
});

describe("openaiResponsesAdapter — usage", () => {
  it("parses a non-streaming response object's top-level usage", () => {
    const usage = openaiResponsesAdapter.parseJsonUsage({
      ...RESPONSE_SHELL,
      status: "completed",
      output: [],
      usage: COMPLETED_USAGE,
    });
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("returns null when the body carries no usage", () => {
    expect(openaiResponsesAdapter.parseJsonUsage({ ...RESPONSE_SHELL, usage: null })).toBeNull();
    expect(
      openaiResponsesAdapter.parseSseUsage(streamEvents("response.completed").slice(0, 5)),
    ).toBeNull();
  });

  it("meters the streamed response.completed event's usage", async () => {
    const usage = await tapSseUsage(
      streamFrom(streamEvents("response.completed")),
      openaiResponsesAdapter,
    );
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("meters a truncated response.incomplete event too (pi-ai finalizes both)", async () => {
    const usage = await tapSseUsage(
      streamFrom(streamEvents("response.incomplete")),
      openaiResponsesAdapter,
    );
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("reassembles a usage event split across network chunks", async () => {
    const whole = streamEvents("response.completed").join("");
    const cut = whole.length - 40;
    const usage = await tapSseUsage(
      streamFrom([whole.slice(0, cut), whole.slice(cut)]),
      openaiResponsesAdapter,
    );
    expect(usage).toEqual(EXPECTED_USAGE);
  });
});

describe("forwardMeteredResponse — openai-responses", () => {
  it("streams verbatim and meters the terminal event's usage", async () => {
    const body = streamEvents("response.completed").join("");
    const { calls, recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: null, recordUsage },
    );
    expect(await res.text()).toBe(body);
    expect((await untilMetered(calls)).usage).toEqual(EXPECTED_USAGE);
  });

  it("rewrites response.model to the alias in every streamed event", async () => {
    const { calls, recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(streamEvents("response.completed").join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: SWAP, recordUsage },
    );
    const out = await res.text();
    expect(out).not.toContain(REAL);
    expect(out.split(`"model":"${SWAP.alias}"`)).toHaveLength(4);
    // Accounting reads the untouched tee branch.
    expect((await untilMetered(calls)).usage).toEqual(EXPECTED_USAGE);
  });

  it("rewrites the non-streaming body's model to the alias and meters it", async () => {
    const { calls, recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(
        JSON.stringify({
          ...RESPONSE_SHELL,
          status: "completed",
          output: [],
          usage: COMPLETED_USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: SWAP, recordUsage },
    );
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe(SWAP.alias);
    expect(calls.map((c) => c.usage)).toEqual([EXPECTED_USAGE]);
  });

  it("passes an upstream error through verbatim and meters nothing", async () => {
    const errorBody = JSON.stringify({
      error: { message: "Invalid 'input'", type: "invalid_request_error", code: null },
    });
    const { calls, recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(errorBody, { status: 400, headers: { "content-type": "application/json" } }),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: null, recordUsage },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(errorBody);
    expect(calls).toEqual([]);
  });
});

/** A terminal `response.completed` event far above the tap's 1 MB frame buffer. */
function oversizedCompletedEvent(response: Record<string, unknown>): string {
  return sse("response.completed", { response, sequence_number: 9 });
}

function chunked(text: string, size = 65_536): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("openaiResponsesAdapter — terminal event above 1 MB", () => {
  const big = "x".repeat(1_500_000);
  // A caller-supplied tool schema can carry a `usage`-shaped object; the
  // vendor's field order is not a contract.
  const decoyTools = [
    {
      type: "function",
      name: "f",
      parameters: {
        type: "object",
        properties: { usage: { input_tokens: 1, output_tokens: 1 } },
      },
    },
  ];

  it("reads the frame's own usage when a tool schema carrying `usage` follows it", async () => {
    const body = oversizedCompletedEvent({
      ...RESPONSE_SHELL,
      instructions: big,
      usage: COMPLETED_USAGE,
      tools: decoyTools,
    });
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("reads usage placed before a large output", async () => {
    const body = oversizedCompletedEvent({
      ...RESPONSE_SHELL,
      usage: COMPLETED_USAGE,
      output: [{ type: "message", content: [{ type: "output_text", text: big }] }],
    });
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("reads no usage from a frame above the bound, and still meters the next one", async () => {
    const over = oversizedCompletedEvent({
      ...RESPONSE_SHELL,
      instructions: big,
      usage: { input_tokens: 999_999, output_tokens: 999_999 },
    });
    const options = { maxFrameChars: 1_000_000 };
    expect(
      await tapSseUsage(streamFrom(chunked(over)), openaiResponsesAdapter, options),
    ).toBeNull();
    // The dropped frame's delimiter straddles the chunk that crossed the bound.
    const next = streamEvents("response.completed").slice(5).join("");
    const chunks = [over.slice(0, -1), over.slice(-1) + next];
    const usage = await tapSseUsage(streamFrom(chunks), openaiResponsesAdapter, options);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("sizes the bound from the request limit plus a fixed output margin", () => {
    expect(usageFrameBound(10 * 1024 * 1024)).toBeGreaterThan(10 * 1024 * 1024);
    expect(usageFrameBound(2_000_000) - 2_000_000).toBe(usageFrameBound(1) - 1);
  });

  it("meters usage from a response.completed frame larger than the buffer (OpenAI field order)", async () => {
    const body =
      streamEvents("response.completed").slice(0, 5).join("") +
      oversizedCompletedEvent({
        ...RESPONSE_SHELL,
        status: "completed",
        instructions: big,
        output: [{ type: "message", content: [{ type: "output_text", text: big }] }],
        tools: [{ type: "function", name: "t", parameters: { description: big } }],
        usage: COMPLETED_USAGE,
        user: null,
        metadata: { k: "v" },
      });
    expect(body.length).toBeGreaterThan(4_000_000);
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("meters usage from an oversized frame whose keys are sorted (usage after tools)", async () => {
    const body = oversizedCompletedEvent({
      created_at: 1,
      id: "resp_1",
      instructions: big,
      model: REAL,
      output: [],
      status: "completed",
      tools: [],
      usage: COMPLETED_USAGE,
      user: null,
    });
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("ignores usage-shaped text inside string values of an oversized frame", async () => {
    const decoy = `"usage":{"input_tokens":999999,"output_tokens":999999}`;
    const body = oversizedCompletedEvent({
      ...RESPONSE_SHELL,
      instructions: big,
      output: [],
      usage: COMPLETED_USAGE,
      metadata: { note: decoy },
    });
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });

  it("returns null for an oversized frame that carries no usage", async () => {
    const body = oversizedCompletedEvent({ ...RESPONSE_SHELL, instructions: big, usage: null });
    expect(await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter)).toBeNull();
  });

  it("still meters a normal terminal frame that follows an oversized one", async () => {
    const body =
      sse("response.output_text.done", { text: big }) +
      streamEvents("response.completed").slice(5).join("");
    const usage = await tapSseUsage(streamFrom(chunked(body)), openaiResponsesAdapter);
    expect(usage).toEqual(EXPECTED_USAGE);
  });
});

describe("openaiResponsesAdapter — request guard", () => {
  function guarded(extra: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = { model: REAL, input: "hi", stream: true, ...extra };
    openaiResponsesAdapter.prepareRequest?.(body);
    return body;
  }

  function refusedParam(extra: Record<string, unknown>): string | undefined {
    try {
      guarded(extra);
    } catch (err) {
      const e = err as { status?: number; code?: string; param?: string };
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_request");
      return e.param;
    }
    throw new Error("request was not refused");
  }

  it("forces store: false, whatever the caller sent", () => {
    expect(guarded({})["store"]).toBe(false);
    expect(guarded({ store: true })["store"]).toBe(false);
  });

  it("refuses request features whose cost the proxy cannot meter", () => {
    expect(refusedParam({ background: true })).toBe("background");
    expect(refusedParam({ previous_response_id: "resp_0" })).toBe("previous_response_id");
    expect(refusedParam({ conversation: "conv_1" })).toBe("conversation");
    expect(refusedParam({ prompt: { id: "pmpt_1" } })).toBe("prompt");
    expect(refusedParam({ service_tier: "priority" })).toBe("service_tier");
    expect(refusedParam({ service_tier: "flex" })).toBe("service_tier");
    expect(refusedParam({ tools: [{ type: "web_search" }] })).toBe("tools");
    expect(
      refusedParam({ tools: [{ type: "function", name: "f" }, { type: "code_interpreter" }] }),
    ).toBe("tools");
  });

  it("accepts the default tiers, unset optional fields, and client-executed tools", () => {
    for (const service_tier of ["auto", "default", null, undefined]) {
      expect(() => guarded({ service_tier })).not.toThrow();
    }
    expect(() =>
      guarded({ background: false, previous_response_id: null, conversation: null, prompt: null }),
    ).not.toThrow();
  });

  it("accepts the request Pi's openai-responses provider builds", () => {
    const piBuilt = {
      input: [{ role: "developer", content: "sys" }],
      prompt_cache_key: "session-1",
      store: false,
      max_output_tokens: 4096,
      tools: [
        { type: "function", name: "read", description: "d", parameters: {}, strict: false },
        { type: "custom", name: "patch", description: "d", format: { type: "grammar" } },
      ],
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    };
    expect(guarded(piBuilt)).toEqual({ model: REAL, stream: true, ...piBuilt });
  });
});

describe("forwardMeteredResponse — openai-responses failed reply under an alias", () => {
  it("replaces a 2xx `status: failed` body naming the real model, and still meters it", async () => {
    const { calls, recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(
        JSON.stringify({
          ...RESPONSE_SHELL,
          status: "failed",
          error: { code: "server_error", message: `The model ${REAL} failed.` },
          output: [],
          usage: COMPLETED_USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: SWAP, recordUsage },
    );
    const text = await res.text();
    expect(text).not.toContain(REAL);
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.model).toBe(SWAP.alias);
    expect(calls.map((c) => c.usage)).toEqual([EXPECTED_USAGE]);
  });

  it("keeps a completed reply with `error: null` on the success path", async () => {
    const { recordUsage } = collectUsage();
    const res = await forwardMeteredResponse(
      new Response(
        JSON.stringify({
          ...RESPONSE_SHELL,
          status: "completed",
          error: null,
          usage: COMPLETED_USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      openaiResponsesAdapter,
      makeCtx(),
      { swap: SWAP, recordUsage },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe(SWAP.alias);
  });
});
