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
// Direct vendor import: `runtime-pi/**/test/**` is exempt from the pi-sdk
// barrel guard, and asking pi-ai's OWN classifier is the point — a copy of its
// regex here would pass forever after the upstream one changed.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
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
  ToolCall,
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
  it("keeps the backing's real token limits — the same pair the container gets", () => {
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

/**
 * Long prompt-cache retention is refused STRUCTURALLY, on the rebuilt record,
 * not by hoping nothing asks for it.
 *
 * The billing reason is in {@link FORWARDED_OPTION_KEYS}: Anthropic bills a 1h
 * cache write at 2x the input rate and the platform's `computeTokenCost`
 * carries one cache-write rate, not two. Dropping `cacheRetention` from the
 * forwarded set closes the request-body route; `compat.supportsLongCacheRetention`
 * closes the class, including the route no whitelist can reach — pi-ai falls
 * back to `PI_CACHE_RETENTION` in the AMBIENT process environment
 * (`resolveCacheRetention`), which is not the request and not this boundary.
 *
 * BEHAVIORAL, like the rest of this file: it reads the bytes pi-ai actually
 * originated, so it fails if a pi upgrade moves the gate rather than passing on
 * a transcription of today's source.
 */
describe("long cache retention", () => {
  const ANTHROPIC = BACKINGS.find((b) => b.apiShape === "anthropic-messages")!;

  it("emits no `ttl` even with `PI_CACHE_RETENTION=long` in the environment", async () => {
    // The env var is the route that survives every request-level defence: on
    // the aliased path pi-ai runs HERE, so this is the sidecar's own
    // environment; on the direct path it is the container's, where agent code
    // can assign `process.env` at will. Restored in `finally` — `bun test`
    // shares one process across the whole repo.
    const prev = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = "long";
    let payload: Record<string, unknown>;
    try {
      payload = await originatedPayload(ANTHROPIC);
    } finally {
      if (prev === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = prev;
    }

    const serialized = JSON.stringify(payload);
    // Non-vacuity: prompt caching is ON. A payload with no `cache_control` at
    // all would pass a bare "no ttl" assertion while proving nothing.
    expect(serialized).toContain('"cache_control"');
    expect(serialized).not.toContain('"ttl"');
  });

  it("control: the same call WITHOUT the flag does emit `ttl: 1h`", async () => {
    // Without this, the assertion above could be passing because the harness
    // cannot see a ttl on any payload. The record is the native one this file
    // already uses as its byte-identical reference — the ONLY difference is
    // the absent `compat`.
    let payload: unknown;
    const model: Model<Api> = {
      id: ANTHROPIC.modelId,
      name: ANTHROPIC.modelId,
      api: ANTHROPIC.apiShape,
      provider: ANTHROPIC.providerId,
      baseUrl: ANTHROPIC.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_TOKENS,
    };
    const result = await streamBacking(model, CONTEXT, {
      apiKey: "sk-real-key",
      cacheRetention: "long",
      onPayload: (next: unknown) => {
        payload = next;
        throw new Error("payload captured");
      },
    }).result();
    expect(result.errorMessage).toBe("payload captured");
    expect(JSON.stringify(payload)).toContain('"ttl":"1h"');
  });
});

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
 * The COMPLETE set of fields `projectAssistantEvent` puts on the wire, per event
 * kind, compared as an EXACT SET in both directions.
 *
 * Sibling of `packages/runner-pi/test/alias-env-allowlist.test.ts`, same argument
 * applied to the other half of the boundary: that gate pins what an aliased
 * container is handed BEFORE it speaks, this one pins what it is handed in reply.
 * The projection is a whitelist rebuild — every field named in source, nothing
 * spread — which makes any ONE projection easy to read and the SET of them easy
 * to grow without anyone noticing. `projectUsage` already drops two fields for no
 * reason other than that their PRESENCE narrows the backing vendor
 * (`Usage.cacheWrite1h`, `Usage.reasoning`); a third such field arriving later,
 * with nobody asking that question, is what this pins against.
 *
 * BOTH directions, for different reasons:
 *
 * - an UNEXPECTED field is a disclosure decision taken by accident;
 * - a MISSING one is a broken run. The signature fields round-trip: pi-ai's
 *   `pi-messages` reader writes them back onto the container's own assistant
 *   message, the container replays that message in the next turn's context, and
 *   this backend re-originates it against the backing — where the Anthropic
 *   adapter reads `thinkingSignature` back out as `signature`, or as
 *   `redacted_thinking` when `redacted` is set. Drop them and multi-turn extended
 *   thinking fails upstream, at the vendor, not here.
 *
 * That second reason is why five of the pinned fields are KNOWN RESIDUALS: they
 * narrow the backing and are kept anyway, because the alternative is not "drop
 * them" but "hold them sidecar-side behind opaque handles", a redesign.
 * `docs/architecture/MODEL_ALIASES.md` (tier 1) records them and what closing
 * them would cost. Each note below says what its field narrows to, measured
 * against the five shapes an alias can be backed by (`ALIAS_BACKING_SHAPES`:
 * anthropic-messages, openai-completions, openai-responses,
 * openai-codex-responses, mistral-conversations).
 */

/**
 * A tool call carrying BOTH of its optional members, so the projection's
 * treatment of each is observable rather than vacuously absent.
 *
 * Residual (2 of 5): `namespace` is written only by the shared openai-responses
 * adapter, so its presence narrows the backing to `openai-responses` /
 * `openai-codex-responses`.
 * Residual (1 of 5): `thoughtSignature` is written by `openai-completions` (from
 * an OpenRouter-style reasoning detail) and by the Google adapters, which cannot
 * back an alias — so among the five it names `openai-completions` outright.
 */
const RESIDUAL_TOOL_CALL: ToolCall = {
  type: "toolCall",
  id: "call_1",
  name: "read",
  arguments: { path: "README.md" },
  thoughtSignature: "reasoning-detail",
  namespace: "custom",
};

/**
 * Content blocks with every optional member set. MAXIMAL on purpose, the same way
 * the env allowlist's fixture is: a source block missing an optional would leave
 * the field absent from the projection, out of the pinned set, and free to appear
 * later without failing anything.
 */
const RESIDUAL_TEXT = { type: "text", text: "hi", textSignature: "text-sig" } as const;
const RESIDUAL_THINKING = {
  type: "thinking",
  thinking: "…",
  thinkingSignature: "enc",
  redacted: true,
} as const;

/**
 * One row per member of the closed `PiMessagesEvent` union — a `Record` keyed by
 * the union, so a new event kind upstream fails to compile here until someone
 * writes down what it may carry.
 *
 * `done` with `reason: "deferred"` has no row: it projects to `undefined`, and the
 * test above owns that case.
 */
const PROJECTION: Record<
  PiMessagesEvent["type"],
  { readonly inbound: AssistantMessageEvent; readonly fields: readonly string[] }
> = {
  start: {
    inbound: { type: "start", partial: partialMessage([]) },
    fields: ["type"],
  },
  text_start: {
    inbound: { type: "text_start", contentIndex: 0, partial: partialMessage([RESIDUAL_TEXT]) },
    fields: ["type", "contentIndex"],
  },
  text_delta: {
    inbound: {
      type: "text_delta",
      contentIndex: 0,
      delta: "hi",
      partial: partialMessage([RESIDUAL_TEXT]),
    },
    fields: ["type", "contentIndex", "delta"],
  },
  text_end: {
    inbound: {
      type: "text_end",
      contentIndex: 0,
      content: "hi",
      partial: partialMessage([RESIDUAL_TEXT]),
    },
    // Residual (2 of 5): `contentSignature` here is the block's `textSignature`,
    // written only by the shared openai-responses adapter among the five.
    fields: ["type", "contentIndex", "content", "contentSignature"],
  },
  thinking_start: {
    inbound: {
      type: "thinking_start",
      contentIndex: 0,
      partial: partialMessage([RESIDUAL_THINKING]),
    },
    fields: ["type", "contentIndex"],
  },
  thinking_delta: {
    inbound: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "…",
      partial: partialMessage([RESIDUAL_THINKING]),
    },
    fields: ["type", "contentIndex", "delta"],
  },
  thinking_end: {
    inbound: {
      type: "thinking_end",
      contentIndex: 0,
      content: "…",
      partial: partialMessage([RESIDUAL_THINKING]),
    },
    // Residual (1 of 5): `redacted` is set by the Anthropic adapter alone —
    // it is how that vendor's safety-filtered thinking is carried back as
    // `redacted_thinking` — so its presence identifies the backing outright.
    // Residual (4 of 5): `contentSignature` here is the block's
    // `thinkingSignature`, which every backing shape but `mistral-conversations`
    // emits; the tell is the weaker one of never seeing it on a reasoning run.
    fields: ["type", "contentIndex", "content", "contentSignature", "redacted"],
  },
  toolcall_start: {
    inbound: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: partialMessage([RESIDUAL_TOOL_CALL]),
    },
    fields: ["type", "contentIndex", "id", "toolName"],
  },
  toolcall_delta: {
    inbound: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":',
      partial: partialMessage([RESIDUAL_TOOL_CALL]),
    },
    fields: ["type", "contentIndex", "delta"],
  },
  toolcall_end: {
    inbound: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: RESIDUAL_TOOL_CALL,
      partial: partialMessage([RESIDUAL_TOOL_CALL]),
    },
    fields: ["type", "contentIndex", "toolCall"],
  },
  done: {
    inbound: {
      type: "done",
      reason: "stop",
      // `responseId` set on the source so its omission from the projection is a
      // measured drop: the wire event DECLARES `responseId` and `rewrite`, both
      // of which would carry the vendor's own identifiers if ever forwarded.
      message: { ...partialMessage([]), stopReason: "stop", usage: USAGE, responseId: "resp_1" },
    },
    fields: ["type", "reason", "usage"],
  },
  error: {
    inbound: {
      type: "error",
      reason: "error",
      // The vendor's own prose and identifiers, on the event whose wire
      // counterpart declares `errorMessage`. Errors are SYNTHESIZED by the
      // caller, never scrubbed, so none of this may cross.
      error: {
        ...partialMessage([]),
        stopReason: "error",
        usage: USAGE,
        responseId: "resp_1",
        errorMessage: "overloaded_error from api.anthropic.com",
      },
    },
    fields: ["type", "reason", "usage"],
  },
};

const WHY_THIS_GATE_EXISTS = [
  "",
  "Every field here crosses into an ALIASED run's container, which the",
  "organization controls and can read. A field is a DISCLOSURE decision, not a",
  "plumbing detail, and has to be justified against the alias contract in",
  "docs/architecture/MODEL_ALIASES.md (tier 1) — which enumerates what the",
  "platform hands an aliased run and states that the list is complete.",
  "",
  "If the field carries the same thing whatever vendor backs the alias, add it",
  "to PROJECTION in this file and say there why it is neutral. If only some",
  "backings emit it — a signature format, a namespace, a token bucket, a",
  "response id — then its PRESENCE narrows the vendor even when its value says",
  "nothing, which is the same argument projectUsage() uses to drop",
  "Usage.cacheWrite1h and Usage.reasoning. Drop it the same way, or, if the",
  "container genuinely needs it back, add it to the residual list in",
  "MODEL_ALIASES.md so the accepted disclosure is written down somewhere.",
  "",
  "A field going MISSING is the opposite failure and just as real: the",
  "signature fields round-trip into the next turn's request, and losing one",
  "fails extended thinking at the vendor rather than here.",
].join("\n");

function expectExactFieldSet(
  actual: readonly string[],
  expected: readonly string[],
  what: string,
): void {
  const unexpected = actual.filter((field) => !expected.includes(field));
  const missing = expected.filter((field) => !actual.includes(field));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new Error(
    [
      `${what} drifted from the pinned field set.`,
      "",
      `  reached the container, not on the list: ${unexpected.join(", ") || "(none)"}`,
      `  on the list, no longer emitted:         ${missing.join(", ") || "(none)"}`,
      WHY_THIS_GATE_EXISTS,
    ].join("\n"),
  );
}

describe("projected event field sets — exact allowlist", () => {
  for (const [kind, { inbound, fields }] of Object.entries(PROJECTION)) {
    it(`emits exactly [${fields.join(", ")}] on ${kind}`, () => {
      const projected = projectAssistantEvent(inbound);
      expect(projected).toBeDefined();
      expectExactFieldSet(
        Object.keys(projected ?? {}).sort(),
        [...fields].sort(),
        `The \`${kind}\` event an ALIASED run receives`,
      );
    });
  }

  it("rebuilds `toolCall` field by field, carrying its two residual members", () => {
    // The one nested object the projection rebuilds besides `usage`. Pinned
    // separately because a vendor field added to pi-ai's `ToolCall` would ride
    // inside it without changing the event's own field set.
    const projected = projectAssistantEvent(PROJECTION.toolcall_end.inbound) as Extract<
      PiMessagesEvent,
      { type: "toolcall_end" }
    >;
    expectExactFieldSet(
      Object.keys(projected.toolCall).sort(),
      ["type", "id", "name", "arguments", "thoughtSignature", "namespace"].sort(),
      "The `toolCall` an ALIASED run receives",
    );
  });

  it("rebuilds `usage` field by field on both terminals", () => {
    // Same reasoning, and this is the one with precedent: `cacheWrite1h` and
    // `reasoning` are already dropped for presence alone, so the set they were
    // dropped from is worth pinning.
    for (const kind of ["done", "error"] as const) {
      const projected = projectAssistantEvent(PROJECTION[kind].inbound) as Extract<
        PiMessagesEvent,
        { type: "done" | "error" }
      >;
      expectExactFieldSet(
        Object.keys(projected.usage).sort(),
        ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].sort(),
        `The \`usage\` on the \`${kind}\` an ALIASED run receives`,
      );
    }
  });

  it("control: the residual fields come from the source, never invented here", () => {
    // Without this the gate would pass on a projection that stamped
    // `contentSignature` / `redacted` unconditionally — the pinned sets would
    // match and nothing would say the fields track the backing's real output.
    const plainText = projectAssistantEvent({
      type: "text_end",
      contentIndex: 0,
      content: "hi",
      partial: partialMessage([{ type: "text", text: "hi" }]),
    });
    expectExactFieldSet(
      Object.keys(plainText ?? {}).sort(),
      ["type", "contentIndex", "content"].sort(),
      "A `text_end` whose source block carries no signature",
    );

    const plainThinking = projectAssistantEvent({
      type: "thinking_end",
      contentIndex: 0,
      content: "…",
      partial: partialMessage([{ type: "thinking", thinking: "…" }]),
    });
    expectExactFieldSet(
      Object.keys(plainThinking ?? {}).sort(),
      ["type", "contentIndex", "content"].sort(),
      "A `thinking_end` whose source block carries no signature",
    );
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

  it("does not forward `cacheRetention` — the container cannot make its run cheaper", async () => {
    // Long Anthropic cache retention bills cache-creation tokens at 2× the
    // input rate, and the platform's authoritative `computeTokenCost` has no
    // term for that bucket. The body is the container's, so forwarding this
    // would let an aliased agent under-bill itself. Pinned from the other side
    // by `apps/api/test/unit/runner-cost-parity.test.ts`.
    const { options, warnings } = await forwardedOptions({
      model: "appstrate-medium",
      context: CONTEXT,
      options: { reasoning: "high", cacheRetention: "long" },
    });

    expect(options["cacheRetention"]).toBeUndefined();
    expect(options["reasoning"]).toBe("high");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!["discarded"]).toEqual(["options.cacheRetention"]);
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
    // 502: pi-ai failed this turn without any upstream response reaching the
    // status probe, which is what "unreachable backing" looks like from here.
    expect(error.errorMessage).toBe("Upstream model error (status 502)");
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
    const body = (await res.json()) as { error: { message: string; model: string } };
    // The alias is in the structured field, not in the classified sentence.
    expect(body.error.model).toBe("appstrate-medium");
    expect(body.error.message).not.toContain("appstrate-medium");
    expect(JSON.stringify(body)).not.toContain("deepseek");
  });

  // --- inter-chunk idle bound ---
  //
  // The alias path re-originates through pi-ai and consumes a GENERATOR, so it
  // does not go through `passUpstream` and inherited none of its bounds. It is
  // also exactly the population that needs one: `pi-messages` is one of the four
  // api shapes that ignore pi-ai's own `timeoutMs`, and the backing rebuilt here
  // can be another (`google-vertex`, `bedrock-converse-stream`). Without the
  // bound a stalled backing burned the whole run budget and died on the
  // wall-clock watchdog with nothing to show.
  //
  // Same instrument as `passUpstream`'s (see `app.test.ts`): armed against the
  // PENDING `next()` and cleared the moment it settles — never a long-lived
  // timer, which the healthy-but-slow control below would catch.

  it("terminates the turn when the backing stream goes silent mid-turn", async () => {
    const stalling: BackingStreamFn = () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: partialMessage([]) } as AssistantMessageEvent;
          // Silent from here on, and never ends — the shape the 30 min absolute
          // cap used to be the only answer to.
          await new Promise(() => {});
        },
      }) as unknown as ReturnType<BackingStreamFn>;

    let frames: PiMessagesEvent[] = [];
    const warnings = await captureWarnings(async () => {
      const res = handlePiMessagesRequest(
        { ...depsFor(BACKINGS[0]!, stalling), llmStreamIdleTimeoutMs: 25 },
        new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
        CLIENT_BODY,
      );
      frames = await readFrames(res);
    });

    // The client MUST see a terminal: without one `pi-messages` cannot
    // reconstruct the assistant message and the turn hangs anyway.
    const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(terminal.type).toBe("error");
    // Neutral prose, as on every other alias failure — the stall must not
    // become the one path that names the backing. 504 is this hop's own verdict
    // ("the backing went silent on me"), and it is what makes the container
    // classify the stall as transient instead of fatal.
    expect(terminal.errorMessage).toBe("Upstream model error (status 504)");
    expect(JSON.stringify(frames)).not.toContain("deepseek");

    const stall = warnings.find(
      (w) => w.msg === "pi-messages backend: upstream went silent mid-stream",
    );
    expect(stall).toMatchObject({ idleTimeoutMs: 25, real: "deepseek-chat" });
  });

  it("does NOT trip on a slow but healthy backing stream", async () => {
    // REGRESSION CONTROL. The upstream answers every `next()` well inside the
    // bound, but the TURN lasts far longer than it. A timer that keeps running
    // across events — or one hung off total elapsed time — would kill this.
    const idleTimeoutMs = 120;
    const gapMs = 40;
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: partialMessage([]) },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial: partialMessage([{ type: "text", text: "hi" }]),
      },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: " there",
        partial: partialMessage([{ type: "text", text: "hi there" }]),
      },
      {
        type: "done",
        reason: "stop",
        message: { ...partialMessage([]), stopReason: "stop", usage: USAGE },
      },
    ];
    const slow: BackingStreamFn = () =>
      ({
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            await new Promise((r) => setTimeout(r, gapMs));
            yield event;
          }
        },
      }) as unknown as ReturnType<BackingStreamFn>;

    const started = Date.now();
    const res = handlePiMessagesRequest(
      { ...depsFor(BACKINGS[0]!, slow), llmStreamIdleTimeoutMs: idleTimeoutMs },
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    const frames = await readFrames(res);

    expect(frames.map((f) => f.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
    // Proof the control tests the right thing: the turn really did outlast the
    // idle bound, so any implementation timing the wrong interval would have
    // terminated it with an `error` frame above.
    expect(Date.now() - started).toBeGreaterThan(idleTimeoutMs);
  });
});

/**
 * Transient-failure handling on the ALIAS path, which had lost both halves of
 * it at once.
 *
 * (1) `projectRequestOptions` sent no `maxRetries`, and pi-ai reads an unset
 * field as ZERO (`options.maxRetries ?? 0`), so the one boundary that can see
 * the backing's `retry-after` spent no attempt on a `429`.
 *
 * (2) The terminal's `errorMessage` was replaced by a status-LESS neutral
 * string. Pi's only retry gate is `isRetryableAssistantError`, a regex over
 * exactly that string, so the container's own turn-level budget never fired
 * either — the identical model on a BYOK credential rode the blip out and the
 * aliased one failed the run.
 *
 * Everything here drives REAL pi-ai (the repo bans `mock.module()`): only the
 * socket is faked, through `deps.fetchImpl`, so the retry loop, the header
 * handling and the SDK's own error shaping are the production ones.
 */
describe("transient upstream failures", () => {
  /**
   * Bun's `typeof fetch` carries a static `preconnect` beside the call
   * signature; forward the real one so a stub is a faithful drop-in.
   */
  function asFetch(
    fn: (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => Promise<Response>,
  ): typeof fetch {
    return Object.assign(fn, { preconnect: fetch.preconnect });
  }

  /**
   * Answer `statuses` in order (repeating the last), recording each call.
   * `retry-after-ms: 1` keeps a real backoff sleep sub-millisecond.
   */
  function scriptedUpstream(statuses: number[]): { fetch: typeof fetch; calls: () => number } {
    let call = 0;
    return {
      calls: () => call,
      fetch: asFetch(async () => {
        const status = statuses[Math.min(call, statuses.length - 1)]!;
        call += 1;
        return new Response(
          JSON.stringify({
            error: { message: "Overloaded, please slow down", type: "rate_limit" },
          }),
          {
            status,
            headers: { "content-type": "application/json", "retry-after-ms": "1" },
          },
        );
      }),
    };
  }

  async function runAgainst(upstream: typeof fetch): Promise<PiMessagesEvent[]> {
    const res = handlePiMessagesRequest(
      { ...depsFor(BACKINGS[0]!), fetchImpl: upstream },
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    return readFrames(res);
  }

  it("spends its retry budget on an upstream 429", async () => {
    // THE NEGATIVE CONTROL. With no `maxRetries` in the projected options this
    // is exactly ONE call: the run fails and is billed while the container's
    // deliberately-patient budget sits unused.
    const upstream = scriptedUpstream([429]);
    await runAgainst(upstream.fetch);
    expect(upstream.calls()).toBeGreaterThan(1);
  });

  it("succeeds on the retry when the blip clears", async () => {
    // Non-vacuity for the case above: retrying is only worth anything if a
    // later attempt can actually settle the turn.
    const upstream = scriptedUpstream([429, 200]);
    let call = 0;
    const withStream = asFetch(async (input, init) => {
      call += 1;
      if (call === 1) return upstream.fetch(input, init);
      const sse =
        `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
        `data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const frames = await runAgainst(withStream);
    expect(call).toBe(2);
    expect(frames.at(-1)?.type).toBe("done");
  });

  it("carries the upstream status into the neutral terminal, so pi retries the turn", async () => {
    const frames = await runAgainst(scriptedUpstream([429]).fetch);
    const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(terminal.type).toBe("error");
    expect(terminal.errorMessage).toBe("Upstream model error (status 429)");

    // Asked of pi-ai's OWN classifier, not of a transcription of its regex —
    // this assertion has to keep meaning something after a pi upgrade.
    expect(
      isRetryableAssistantError({
        ...partialMessage([]),
        stopReason: "error",
        errorMessage: terminal.errorMessage!,
      }),
    ).toBe(true);
  });

  it("control: a 400 stays NON-retryable, so the status is doing the work", async () => {
    // Without this the assertion above could pass on any neutral string that
    // happens to match — e.g. if the alias name alone tripped the regex.
    const frames = await runAgainst(scriptedUpstream([400]).fetch);
    const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
    expect(terminal.errorMessage).toBe("Upstream model error (status 400)");
    expect(
      isRetryableAssistantError({
        ...partialMessage([]),
        stopReason: "error",
        errorMessage: terminal.errorMessage!,
      }),
    ).toBe(false);
  });

  it("collapses a vendor-fingerprinting status to a generic gateway error", async () => {
    // `529` is Anthropic's own "overloaded" code and `520`–`526` are
    // Cloudflare's — forwarding either tells the container which backing it is
    // really talking to, which is the one thing the alias boundary exists to
    // withhold. They are projected to 502, which `isRetryableAssistantError`
    // already treats as retryable, so nothing is lost but the fingerprint.
    for (const fingerprint of [529, 520, 524]) {
      const frames = await runAgainst(scriptedUpstream([fingerprint]).fetch);
      const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
      expect(terminal.errorMessage).toBe("Upstream model error (status 502)");
      expect(
        isRetryableAssistantError({
          ...partialMessage([]),
          stopReason: "error",
          errorMessage: terminal.errorMessage!,
        }),
      ).toBe(true);
    }
  });

  it("control: a generic status is still forwarded verbatim", async () => {
    // Without this the collapse above could be a blanket 502 that throws away
    // the 429/400 partition the two cases before this one depend on.
    //
    // 405/413/415 are here on the second axis: they are verdicts on the HTTP
    // framing that any server answers, so they fingerprint nothing, and they
    // are TERMINAL. Collapsed to 502 they would land inside pi-ai's retryable
    // pattern and the container would spend its whole budget re-sending an
    // oversized prompt.
    for (const generic of [401, 404, 409, 503, 405, 413, 415]) {
      const frames = await runAgainst(scriptedUpstream([generic]).fetch);
      const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
      expect(terminal.errorMessage).toBe(`Upstream model error (status ${generic})`);
    }
  });

  it("collapses a PERMANENT vendor-identifying status without making it retryable", async () => {
    // The defect this case exists for: the two axes were traded against each
    // other. 402 (an aggregating gateway out of credit — Anthropic, OpenAI and
    // Mistral have no 402), 422 (Mistral's validation verdict where the others
    // answer 400) and 431 (an edge/CDN code) each name the backing, so they
    // must be collapsed; and each is PERMANENT, so collapsing them to the
    // transient 502 target would have the container retry to exhaustion.
    //
    // 402 is the sharpest: pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
    // keys on words like "billing" and "insufficient_quota", and this boundary
    // has already replaced every one of them with "Upstream model error" — the
    // projected status is the ONLY signal left.
    for (const fingerprint of [402, 422, 431]) {
      const frames = await runAgainst(scriptedUpstream([fingerprint]).fetch);
      const terminal = frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
      // Opaque: the upstream number never reaches the container.
      expect(terminal.errorMessage).toBe("Upstream model error (status 400)");
      // AND terminal, asked of pi-ai's own classifier rather than a
      // transcription of its regex.
      expect(
        isRetryableAssistantError({
          ...partialMessage([]),
          stopReason: "error",
          errorMessage: terminal.errorMessage!,
        }),
      ).toBe(false);
    }
  });

  /**
   * THE ESCAPE HATCH from the terminal-vs-transient projection: an alias is
   * ORG-CONTROLLED text, and the field pi-ai classifies is a substring match.
   * Interpolated into it, `gpt-500-fast` (not a contrived name) matched the
   * `500` literal in `RETRYABLE_PROVIDER_ERROR_PATTERN` and made EVERY failure
   * on that alias retryable — including the terminal `400` this boundary
   * collapses a permanent, vendor-identifying failure to. The org, not the
   * transaction, decided the retry verdict.
   *
   * The fix is structural, not a keyword filter: `syntheticAliasClassifier\
   * Message` takes no `ModelSwap`, so there is nothing org-controlled to
   * interpolate. Sanitizing against pi-ai's list would couple this boundary to
   * their internals and rot the first time they add a pattern.
   */
  const HOSTILE_ALIASES = [
    "gpt-500-fast",
    "turbo-502",
    "claude-overloaded-x",
    "rate-limit-lite",
    "model-524-preview",
    "timeout-tuned-3",
  ];

  /** Drive one aliased turn under `alias`, and report the terminal event. */
  async function runUnderAlias(
    alias: string,
    upstream: typeof fetch,
  ): Promise<Extract<PiMessagesEvent, { type: "error" }>> {
    const base = depsFor(BACKINGS[0]!);
    const res = handlePiMessagesRequest(
      { ...base, swap: { ...base.swap, alias }, fetchImpl: upstream },
      new Request("http://sidecar:8080/llm/messages", { method: "POST" }),
      CLIENT_BODY,
    );
    const frames = await readFrames(res);
    return frames.at(-1) as Extract<PiMessagesEvent, { type: "error" }>;
  }

  it("an alias carrying 500/502/overloaded cannot make a terminal failure retryable", async () => {
    for (const alias of HOSTILE_ALIASES) {
      // 402 is a permanent, vendor-identifying failure: it collapses to the
      // TERMINAL 400 target, and that verdict must survive the alias.
      const terminal = await runUnderAlias(alias, scriptedUpstream([402]).fetch);
      expect(terminal.errorMessage).toBe("Upstream model error (status 400)");
      // Asked of pi-ai's OWN classifier — a hand-copied regex would rot exactly
      // the way the docstring this fix replaced did.
      expect(
        isRetryableAssistantError({
          ...partialMessage([]),
          stopReason: "error",
          errorMessage: terminal.errorMessage!,
        }),
      ).toBe(false);
      // The name never reaches the classified field at all — the property, not
      // a spot-check on the six names above.
      expect(terminal.errorMessage).not.toContain(alias);
    }
  });

  it("control: the status still partitions retryable from terminal under a hostile alias", async () => {
    // Without this the case above could pass by a message so neutral it is
    // ALWAYS terminal, which would silently take back the container's retry
    // budget on a real 429.
    const terminal = await runUnderAlias("gpt-500-fast", scriptedUpstream([429]).fetch);
    expect(terminal.errorMessage).toBe("Upstream model error (status 429)");
    expect(
      isRetryableAssistantError({
        ...partialMessage([]),
        stopReason: "error",
        errorMessage: terminal.errorMessage!,
      }),
    ).toBe(true);
  });

  it("still names nothing: the upstream's own error body never reaches the client", async () => {
    // The status travels; the prose does not. A 429 body is exactly where a
    // provider writes its rate-limit copy, its model id and its own vocabulary.
    const frames = await runAgainst(scriptedUpstream([429]).fetch);
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain("deepseek");
    expect(serialized).not.toContain("Overloaded, please slow down");
    expect(serialized).not.toContain("rate_limit");
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
