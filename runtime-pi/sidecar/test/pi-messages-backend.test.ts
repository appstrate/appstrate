// SPDX-License-Identifier: Apache-2.0

/**
 * GATE 2 — the sidecar's re-origination of an aliased run's inference call is
 * byte-identical to the native (non-proxied) call for the same backing.
 *
 * Moving the vendor dialect out of the container only works if the sidecar
 * still produces exactly what the vendor expects, so the guarantee is that the
 * `Model` record the backend rebuilds drives pi-ai into the same shape a direct
 * call would. That is what makes it safe for the backend to mirror no quirk
 * table at all.
 *
 * BEHAVIORAL: it compares real payloads captured through pi-ai's own
 * `onPayload` hook, never source text. This design transcribes nothing, so it
 * must not acquire a text oracle that fires on cosmetic upstream reformatting.
 *
 * The rest of the file covers the two things the projection must not get wrong:
 * `done` must carry the real token counts (the platform prices the ledger row
 * from them), and nothing vendor-named may reach the client on any path.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { anthropicThinkingBudgets } from "@appstrate/core/model-generation";
import type { LlmProxyApiKeyConfig, ModelSwap } from "../helpers.ts";
import { _setLogSinkForTesting } from "../logger.ts";
import { PI_SDK_VERSION, PI_SDK_VERSION_HEADER } from "@appstrate/runner-pi/provider-map";
import {
  _resetSdkDriftWarningForTesting,
  buildBackingModel,
  FORWARDED_OPTION_KEYS,
  handlePiMessagesRequest,
  projectAssistantEvent,
  type BackingStreamFn,
  type PiMessagesBackendDeps,
} from "../pi-messages-backend.ts";
import { streamBacking } from "../pi-sdk.ts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  PiMessagesEvent,
  Usage,
} from "../pi-sdk.ts";

const CONTEXT: Context = {
  systemPrompt: "You are a helpful agent.",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

/** The `{ model, context, options }` body an aliased container POSTs. */
const CLIENT_BODY = JSON.stringify({
  model: "appstrate-medium",
  context: CONTEXT,
  options: { maxTokens: 4_096, reasoning: "high", temperature: 0.5 },
});

interface Backing {
  name: string;
  providerId: string;
  apiShape: ModelSwap["backingApiShape"];
  modelId: string;
  baseUrl: string;
}

/**
 * The same vendor spread Gate 1 uses, minus the oauth-subscription protocol.
 * Each drives a DIFFERENT branch of pi-ai's per-vendor request shaping, which
 * is what keeps an identical-payload comparison from being vacuous.
 */
const BACKINGS: Backing[] = [
  {
    name: "deepseek",
    providerId: "deepseek",
    apiShape: "openai-completions",
    modelId: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    name: "zai",
    providerId: "zai",
    apiShape: "openai-completions",
    modelId: "glm-5",
    baseUrl: "https://api.z.ai/api/paas/v4",
  },
  {
    name: "openai responses",
    providerId: "openai",
    apiShape: "openai-responses",
    modelId: "gpt-5",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    name: "anthropic",
    providerId: "anthropic",
    apiShape: "anthropic-messages",
    modelId: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
  },
  {
    name: "mistral",
    providerId: "mistral",
    apiShape: "mistral-conversations",
    modelId: "mistral-large-latest",
    baseUrl: "https://api.mistral.ai",
  },
];

const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 32_768;

function depsFor(backing: Backing, streamBackingFn?: BackingStreamFn): PiMessagesBackendDeps {
  const llm: LlmProxyApiKeyConfig = {
    authMode: "api_key",
    baseUrl: backing.baseUrl,
    apiKey: "sk-real-key",
    placeholder: "sk-placeholder",
  };
  const swap: ModelSwap = {
    alias: "appstrate-medium",
    real: backing.modelId,
    clientApiShape: "pi-messages",
    backingApiShape: backing.apiShape,
    backing: {
      providerId: backing.providerId,
      reasoning: true,
      reasoningLevelMap: { high: "high" },
      input: ["text"],
    },
  };
  return {
    llm,
    swap,
    limits: { modelContextWindow: CONTEXT_WINDOW, modelMaxTokens: MAX_TOKENS },
    ...(streamBackingFn ? { streamBackingFn } : {}),
  };
}

/**
 * Drive the handler and capture the request pi-ai originated. The stream
 * function is injected (the repo bans `mock.module()`) and wraps the REAL pi-ai
 * dispatcher with `onPayload`, so what is captured is what the production path
 * would have sent — not a re-implementation of it.
 */
async function originatedPayload(backing: Backing): Promise<Record<string, unknown>> {
  let payload: unknown;
  const capture: BackingStreamFn = (model, context, options) =>
    streamBacking(model, context, {
      ...options,
      onPayload: (next: unknown) => {
        payload = next;
        // Stops before any network I/O: pi-ai turns the throw into the
        // stream's terminal error event.
        throw new Error("payload captured");
      },
    });
  const res = handlePiMessagesRequest(
    depsFor(backing, capture),
    new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
    CLIENT_BODY,
  );
  await res.text();
  expect(payload).toBeDefined();
  return payload as Record<string, unknown>;
}

/** The payload a NATIVE (non-proxied) pi-ai call for the same backing produces. */
async function nativePayload(backing: Backing): Promise<Record<string, unknown>> {
  let payload: unknown;
  const model: Model<Api> = {
    id: backing.modelId,
    name: backing.modelId,
    api: backing.apiShape,
    provider: backing.providerId,
    baseUrl: backing.baseUrl,
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
  };
  const result = await streamBacking(model, CONTEXT, {
    apiKey: "sk-real-key",
    maxTokens: 4_096,
    reasoning: "high",
    temperature: 0.5,
    // What a DIRECT Appstrate run sends: the same core-owned budget for a
    // classic Anthropic call. Without it "native" would mean bare pi rather
    // than the platform's own direct path.
    ...(backing.apiShape === "anthropic-messages"
      ? { thinkingBudgets: anthropicThinkingBudgets("high") }
      : {}),
    onPayload: (next: unknown) => {
      payload = next;
      throw new Error("payload captured");
    },
  }).result();
  expect(result.errorMessage).toBe("payload captured");
  return payload as Record<string, unknown>;
}

describe("re-originated request shape", () => {
  for (const backing of BACKINGS) {
    it(`is byte-identical to the native ${backing.name} request`, async () => {
      expect(await originatedPayload(backing)).toEqual(await nativePayload(backing));
    });
  }

  it("control: the comparison is not vacuous — vendors really do differ", async () => {
    // Two backings on the SAME protocol family whose request shapes diverge
    // (`system` + `max_tokens` + a `thinking` block for DeepSeek vs `developer`
    // + `max_completion_tokens` for OpenAI). Without this, an `onPayload` that
    // silently stopped firing would make every case above compare `undefined`
    // to `undefined`.
    const deepseek = await originatedPayload(BACKINGS[0]!);
    const openai = await originatedPayload({
      name: "openai completions",
      providerId: "openai",
      apiShape: "openai-completions",
      modelId: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(deepseek).not.toEqual(openai);
  });

  it("restores the Anthropic thinking budget the canonical protocol cannot carry", async () => {
    // `PiMessagesOptions` models no budget, so the container cannot send one
    // and `pi-runner`'s own branch never fires for an aliased run. Without the
    // sidecar re-applying the rule, a `max` request drops to pi's built-in
    // table, which collapses `xhigh` AND `max` onto 16384.
    let payload: unknown;
    const capture: BackingStreamFn = (model, context, options) =>
      streamBacking(model, context, {
        ...options,
        onPayload: (next: unknown) => {
          payload = next;
          throw new Error("payload captured");
        },
      });
    const anthropic = BACKINGS.find((b) => b.apiShape === "anthropic-messages")!;
    const res = handlePiMessagesRequest(
      depsFor(anthropic, capture),
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      JSON.stringify({
        model: "appstrate-medium",
        context: CONTEXT,
        options: { reasoning: "max" },
      }),
    );
    await res.text();
    const thinking = (payload as { thinking?: { budget_tokens?: number } }).thinking;
    // A bound, not an exact figure: pi shaves a reserve off a budget that would
    // consume the whole response cap, and pinning that arithmetic would make
    // this a test of pi rather than of the restoration. 16384 is what pi's own
    // table yields for `max`, so anything above it can only come from the
    // override.
    expect(thinking?.budget_tokens).toBeGreaterThan(16_384);
  });

  it("sends the REAL model id upstream, never the alias", async () => {
    const payload = await originatedPayload(BACKINGS[0]!);
    expect(payload["model"]).toBe("deepseek-chat");
  });
});

describe("buildBackingModel", () => {
  it("keeps the REAL token limits, not the container's masked pair", () => {
    const model = buildBackingModel(depsFor(BACKINGS[0]!));
    expect(model.contextWindow).toBe(CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(MAX_TOKENS);
  });

  it("carries zero rates so no rate card can reach the container", () => {
    // pi-ai writes `usage.cost` from `Model.cost` on every settled turn and
    // that number rides the terminal `done` event straight to the client, where
    // a published per-token card names the vendor on its own.
    const model = buildBackingModel(depsFor(BACKINGS[0]!));
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to pi's own defaults when the platform resolved no limits", () => {
    const deps = depsFor(BACKINGS[0]!);
    const model = buildBackingModel({ ...deps, limits: {} });
    // 0 is pi-ai's "do not clamp" sentinel.
    expect(model.contextWindow).toBe(0);
    // pi's own default for a model definition declaring no maxTokens.
    expect(model.maxTokens).toBe(16_384);
  });

  it("forces the adaptive Anthropic shape when the descriptor says the backing is adaptive", async () => {
    // The container cannot know this — hence the descriptor — and pi-ai's own
    // adaptive metadata does not cover a record we rebuilt rather than it
    // resolved. Without the flag an adaptive backing answers 400.
    const anthropic = BACKINGS.find((b) => b.apiShape === "anthropic-messages")!;
    let payload: unknown;
    const capture: BackingStreamFn = (model, context, options) =>
      streamBacking(model, context, {
        ...options,
        onPayload: (next: unknown) => {
          payload = next;
          throw new Error("payload captured");
        },
      });
    const deps = depsFor(anthropic, capture);
    const res = handlePiMessagesRequest(
      { ...deps, swap: { ...deps.swap, anthropicAdaptiveReasoning: { effort: "max" } } },
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    await res.text();
    const body = payload as { thinking?: { type?: string }; output_config?: { effort?: string } };
    expect(body.thinking?.type).toBe("adaptive");
    // Effort resolved from the backing's own `thinkingLevelMap` (`high` → `high`),
    // not from a value the container could have influenced.
    expect(body.output_config?.effort).toBe("high");
    expect(body).not.toHaveProperty("thinking.budget_tokens");
  });

  it("refuses to re-originate without the backing catalog", () => {
    const deps = depsFor(BACKINGS[0]!);
    const { backing: _drop, ...swap } = deps.swap;
    expect(() => buildBackingModel({ ...deps, swap })).toThrow(/backing is required/);
  });
});

/** Minimal assistant message pi-ai attaches to every event as `partial`. */
function partialMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    // The three identity fields the projection MUST drop: vendor, protocol and
    // the real backing id, stamped on `partial` for every single event.
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: USAGE,
    stopReason: "pending",
    timestamp: 0,
  };
}

const USAGE: Usage = {
  input: 100,
  output: 42,
  cacheRead: 7,
  cacheWrite: 3,
  cacheWrite1h: 3,
  reasoning: 11,
  totalTokens: 152,
  cost: { input: 0.28, output: 0.42, cacheRead: 0.01, cacheWrite: 0.02, total: 0.73 },
};

describe("event projection", () => {
  it("drops `partial` — the vendor identity rides on it, on every event", () => {
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: partialMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: partialMessage([{ type: "text", text: "" }]),
      },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial: partialMessage([{ type: "text", text: "hi" }]),
      },
      {
        type: "text_end",
        contentIndex: 0,
        content: "hi",
        partial: partialMessage([{ type: "text", text: "hi", textSignature: "sig" }]),
      },
    ];
    for (const event of events) {
      const projected = projectAssistantEvent(event);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain("deepseek");
      expect(serialized).not.toContain("openai-completions");
      expect(projected).not.toHaveProperty("partial");
    }
  });

  it("recovers the fields the wire event declares but pi-ai's does not", () => {
    // `toolcall_start` carries no id/name on pi-ai's side; `text_end` and
    // `thinking_end` carry no signature. All three are read back from the named
    // content block, so the projection is not a pure field drop.
    expect(
      projectAssistantEvent({
        type: "toolcall_start",
        contentIndex: 0,
        partial: partialMessage([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]),
      }),
    ).toEqual({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" });

    expect(
      projectAssistantEvent({
        type: "text_end",
        contentIndex: 0,
        content: "hi",
        partial: partialMessage([{ type: "text", text: "hi", textSignature: "sig" }]),
      }),
    ).toEqual({ type: "text_end", contentIndex: 0, content: "hi", contentSignature: "sig" });

    expect(
      projectAssistantEvent({
        type: "thinking_end",
        contentIndex: 0,
        content: "…",
        partial: partialMessage([
          { type: "thinking", thinking: "…", thinkingSignature: "enc", redacted: true },
        ]),
      }),
    ).toEqual({
      type: "thinking_end",
      contentIndex: 0,
      content: "…",
      contentSignature: "enc",
      redacted: true,
    });
  });

  it("keeps the four priced token buckets on `done` and drops the vendor tells", () => {
    const projected = projectAssistantEvent({
      type: "done",
      reason: "stop",
      message: { ...partialMessage([]), stopReason: "stop", usage: USAGE },
    }) as Extract<PiMessagesEvent, { type: "done" }>;

    // The platform prices `llm_usage.cost_usd` from exactly these four counts,
    // so losing one loses the bill.
    expect(projected.usage.input).toBe(100);
    expect(projected.usage.output).toBe(42);
    expect(projected.usage.cacheRead).toBe(7);
    expect(projected.usage.cacheWrite).toBe(3);
    expect(projected.usage.totalTokens).toBe(152);

    // The two OPTIONAL members are vendor tells and are not priced:
    // `cacheWrite1h` is Anthropic-only, `reasoning` is reported only by
    // providers that expose a breakdown.
    expect(projected.usage).not.toHaveProperty("cacheWrite1h");
    expect(projected.usage).not.toHaveProperty("reasoning");
    // And the rate card pi-ai computed never travels.
    expect(projected.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  it("has no wire counterpart for a deferred terminal", () => {
    // Batch/deferred responses cannot be requested over pi-messages and this
    // backend never enables them; the caller synthesizes the neutral terminal.
    expect(
      projectAssistantEvent({
        type: "done",
        reason: "deferred",
        message: { ...partialMessage([]), stopReason: "deferred" },
      }),
    ).toBeUndefined();
  });
});

/**
 * Capture the warn/error lines the sidecar logger emits during `fn`.
 *
 * The sink belongs to this call (`_setLogSinkForTesting`), not the global
 * `process.stdout.write`: `bun test` runs the whole repo in one process, so a
 * global capture would also collect what other suites write — and every line
 * here is `JSON.parse`d, so one foreign frame is a hard `SyntaxError` on an
 * innocent test.
 */
async function captureWarnings(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  // The shared test preload pins `LOG_LEVEL=error` and the logger checks that
  // threshold BEFORE reaching the sink, so a warn would never arrive. Lowered
  // for this call only, and restored.
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  const lines: string[] = [];
  _setLogSinkForTesting((lineLevel, line) => {
    if (lineLevel === "warn" || lineLevel === "error") lines.push(line);
  });
  try {
    await fn();
  } finally {
    _setLogSinkForTesting(null);
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  }
  return lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Run one request through the backend, capturing the options it forwarded. */
async function forwardedOptions(
  body: unknown,
  path = "/llm/messages",
): Promise<{ options: Record<string, unknown>; warnings: Array<Record<string, unknown>> }> {
  let seen: Record<string, unknown> = {};
  const capture: BackingStreamFn = (_model, _context, options) => {
    seen = options as unknown as Record<string, unknown>;
    return fakeStream([]);
  };
  const warnings = await captureWarnings(async () => {
    const res = handlePiMessagesRequest(
      depsFor(BACKINGS[0]!, capture),
      new Request(`http://sidecar:8080${path}`, { method: "POST" }),
      JSON.stringify(body),
    );
    await res.text();
  });
  return { options: seen, warnings };
}

/**
 * A field that reaches this boundary and does not reach the backing must SAY
 * so. Not forwarding `toolChoice` is a decision (its value space is per-vendor,
 * so honouring it means the mapping table this design avoids); "no client sends
 * it today" is a fact about the installed pi version. If a future pi starts
 * sending it, the constraint the agent asked for would vanish here with no
 * error and nothing in the run to find.
 */
describe("discarded request fields", () => {
  it("warns that `toolChoice` was not forwarded, and does not forward it", async () => {
    const { options, warnings } = await forwardedOptions({
      model: "appstrate-medium",
      context: CONTEXT,
      options: { reasoning: "high", toolChoice: { type: "function", function: { name: "read" } } },
    });

    expect(options["toolChoice"]).toBeUndefined();
    // The portable neighbour on the same object still crosses, so this is a
    // targeted drop rather than the whole options object being ignored.
    expect(options["reasoning"]).toBe("high");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!["discarded"]).toEqual(["options.toolChoice"]);
    expect(String(warnings[0]!["msg"])).toContain("not forwarded");
  });

  it("warns about `debug`, which rides the URL query rather than the body", async () => {
    // `?debug=1` asks a backend for routing metadata about itself, which for an
    // alias is the one thing this boundary exists not to answer.
    const { warnings } = await forwardedOptions(
      { model: "appstrate-medium", context: CONTEXT, options: {} },
      "/llm/messages?debug=1",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!["discarded"]).toEqual(["query.debug"]);
  });

  it("reports an option a FUTURE pi-ai adds, without anyone updating a blacklist", async () => {
    // Reported as a SET DIFFERENCE against what this boundary forwards, never a
    // two-name list — so the day pi-messages grows a seventh option the drop is
    // visible instead of silent.
    const { warnings } = await forwardedOptions({
      model: "appstrate-medium",
      context: CONTEXT,
      options: { someOptionPiAddsLater: true },
    });
    expect(warnings[0]!["discarded"]).toEqual(["options.someOptionPiAddsLater"]);
  });

  it("stays silent — and actually forwards — for every key it claims to forward", async () => {
    // Closes the drift between `FORWARDED_OPTION_KEYS` and the projection that
    // reads it: a key in the set but missing from the projection would be
    // dropped silently, the exact defect this suite exists for.
    for (const key of FORWARDED_OPTION_KEYS) {
      const value = key === "temperature" || key === "maxTokens" ? 1 : "medium";
      const { options, warnings } = await forwardedOptions({
        model: "appstrate-medium",
        context: CONTEXT,
        options: { [key]: value },
      });
      expect({ key, forwarded: options[key], warnings: warnings.length }).toEqual({
        key,
        forwarded: value,
        warnings: 0,
      });
    }
  });

  it("names no model, provider or value — sidecar logs are operator-visible", async () => {
    const { warnings } = await forwardedOptions({
      model: "appstrate-medium",
      context: CONTEXT,
      options: { toolChoice: { type: "function", function: { name: "secret_tool" } } },
    });
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain("deepseek");
    expect(serialized).not.toContain("api.deepseek.com");
    // The VALUE is dropped too — only the field name is reported.
    expect(serialized).not.toContain("secret_tool");
  });
});

/** Read an SSE response body into its parsed `data:` frames. */
async function readFrames(res: Response): Promise<PiMessagesEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as PiMessagesEvent);
}

describe("handlePiMessagesRequest", () => {
  it("streams the projected events and terminates on `done`", async () => {
    const stream: BackingStreamFn = () =>
      fakeStream([
        { type: "start", partial: partialMessage([]) },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "hi",
          partial: partialMessage([{ type: "text", text: "hi" }]),
        },
        {
          type: "done",
          reason: "stop",
          message: { ...partialMessage([]), stopReason: "stop", usage: USAGE },
        },
      ]);
    const res = handlePiMessagesRequest(
      depsFor(BACKINGS[0]!, stream),
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const frames = await readFrames(res);
    expect(frames.map((f) => f.type)).toEqual(["start", "text_delta", "done"]);
    const done = frames[2] as Extract<PiMessagesEvent, { type: "done" }>;
    expect(done.usage.totalTokens).toBe(152);
  });

  it("replaces pi-ai's error prose, which interpolates the provider", async () => {
    const stream: BackingStreamFn = () =>
      fakeStream([
        {
          type: "error",
          reason: "error",
          error: {
            ...partialMessage([]),
            stopReason: "error",
            // Verbatim shape of pi-ai's own message on a missing key.
            errorMessage: 'No API key provided for provider "deepseek"',
          },
        },
      ]);
    const res = handlePiMessagesRequest(
      depsFor(BACKINGS[0]!, stream),
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    // 200 + SSE even on failure: pi-ai's `pi-messages` reader treats a non-2xx
    // as a transport failure and never reaches the terminal event, so a refusal
    // has to arrive as an error EVENT to read as a failed turn.
    expect(res.status).toBe(200);

    const frames = await readFrames(res);
    const error = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(error.type).toBe("error");
    expect(error.errorMessage).toBe('Upstream model error (model "appstrate-medium")');
    expect(JSON.stringify(frames)).not.toContain("deepseek");
  });

  it("always terminates, even when the upstream stream ends silently", async () => {
    const res = handlePiMessagesRequest(
      depsFor(BACKINGS[0]!, () => fakeStream([])),
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    const frames = await readFrames(res);
    // Without a terminal the client cannot reconstruct the assistant message
    // and the turn hangs.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("error");
  });

  it("refuses an unusable body with the neutral envelope", async () => {
    const res = handlePiMessagesRequest(
      depsFor(BACKINGS[0]!, () => fakeStream([])),
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      "{not json",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("appstrate-medium");
    expect(JSON.stringify(body)).not.toContain("deepseek");
  });
});

/**
 * The agent container and the sidecar ship as separate images and deploy
 * independently, so a partial rollout can pair pi-ai versions across a protocol
 * whose event union is internal to pi-ai. Naming that costs one log line;
 * missing it costs a bisect. The latch is a single process-wide flag, so each
 * case below resets it in `beforeEach` to stay order-independent.
 */
describe("pi-ai version drift", () => {
  beforeEach(() => _resetSdkDriftWarningForTesting());

  /** Drive one request carrying `header`, and report what the logger emitted. */
  async function requestWith(
    header: string | undefined,
    times = 1,
  ): Promise<{ warnings: Array<Record<string, unknown>>; forwarded: Record<string, unknown> }> {
    let model: Record<string, unknown> = {};
    let options: Record<string, unknown> = {};
    const capture: BackingStreamFn = (m, _context, o) => {
      model = m as unknown as Record<string, unknown>;
      options = o as unknown as Record<string, unknown>;
      return fakeStream([]);
    };
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < times; i++) {
        const res = handlePiMessagesRequest(
          depsFor(BACKINGS[0]!, capture),
          new Request("http://sidecar:8080/llm/messages", {
            method: "POST",
            ...(header !== undefined ? { headers: { [PI_SDK_VERSION_HEADER]: header } } : {}),
          }),
          CLIENT_BODY,
        );
        await res.text();
      }
    });
    return {
      warnings,
      forwarded: { modelHeaders: model["headers"], optionHeaders: options["headers"] },
    };
  }

  it("says nothing when the container reports the same version", async () => {
    const { warnings } = await requestWith(PI_SDK_VERSION);
    expect(warnings).toEqual([]);
  });

  it("says nothing when the header is absent", async () => {
    // A container image predating this change sends nothing. That must not warn
    // on every request of every aliased run.
    const { warnings } = await requestWith(undefined);
    expect(warnings).toEqual([]);
  });

  it("warns once even for many DISTINCT versions — the header is container-controlled", async () => {
    // Keying the latch on the header value would let the container grow the
    // sidecar's memory and flood its logs one fresh value at a time.
    const warnings = await captureWarnings(async () => {
      for (let i = 0; i < 50; i++) {
        const res = handlePiMessagesRequest(
          depsFor(BACKINGS[0]!, () => fakeStream([])),
          new Request("http://sidecar:8080/llm/messages", {
            method: "POST",
            headers: { [PI_SDK_VERSION_HEADER]: `9.9.${i}` },
          }),
          CLIENT_BODY,
        );
        await res.text();
      }
    });
    expect(warnings).toHaveLength(1);
  });

  it("truncates the container-supplied version in the log line", async () => {
    const { warnings } = await requestWith("x".repeat(4096));
    expect(warnings[0]).toMatchObject({ container: "x".repeat(32) });
  });

  it("warns ONCE per mismatched version, naming both", async () => {
    const { warnings, forwarded } = await requestWith("0.85.0", 3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ container: "0.85.0", sidecar: PI_SDK_VERSION });
    // The inbound header is a container↔sidecar fact; it must not ride upstream.
    expect(forwarded).toEqual({ modelHeaders: undefined, optionHeaders: undefined });
  });
});

/**
 * A stand-in for pi-ai's `AssistantMessageEventStream` that replays a fixed
 * event list. The handler only ever iterates, so an async iterable is the whole
 * contract it depends on; the cast covers the concrete class members it never
 * touches.
 */
function fakeStream(events: AssistantMessageEvent[]): ReturnType<BackingStreamFn> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  } as unknown as ReturnType<BackingStreamFn>;
}
