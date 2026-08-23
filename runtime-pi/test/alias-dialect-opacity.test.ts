// SPDX-License-Identifier: Apache-2.0

/**
 * GATE 1 — an ALIASED run's container emits nothing that varies with the
 * backing vendor (issue #1198, Threat B).
 *
 * The requirement this defends: an organization member who ACTIVELY looks must
 * not be able to identify the backing vendor from any Appstrate surface. The
 * member controls the agent code, so the observable is the RAW BYTES on the
 * wire — they can wrap `fetch` inside the container, or call the sidecar
 * directly. pi-ai re-derives every vendor quirk per request from
 * `model.provider` + `model.baseUrl` (`getCompat` / `detectCompat`), so as long
 * as the container is told the real provider it emits that vendor's own request
 * shape: `developer` vs `system` roles, `max_completion_tokens` vs
 * `max_tokens`, each vendor's thinking dialect, and so on.
 *
 * The gate is BEHAVIORAL on purpose: it captures the real payload through
 * pi-ai's own `onPayload` hook. This design transcribes nothing from pi-ai, so
 * it must not acquire a source-text oracle that would fire on a cosmetic
 * upstream reformatting.
 *
 * And the model under test is not hand-constructed. It is built from
 * `buildRuntimePiEnv`'s ACTUAL output for an aliased run, parsed back by the
 * container's own `parseRuntimeEnv`, and turned into a Pi model by the
 * container's own `buildPiModelFromEnv` — the same three steps a real run
 * takes. That join is what makes the gate real: a hand-built model would keep
 * passing after a launcher change that started leaking the provider again.
 */

import { describe, it, expect } from "bun:test";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import { buildPiModelFromEnv, parseRuntimeEnv } from "../env.ts";
import { streamSimple } from "../pi-sdk.ts";
import type { Api, Model } from "../pi-sdk.ts";

/**
 * A platform backing an alias could be bound to. The four fields below are
 * exactly the ones that used to reach the container and identify the vendor:
 * the provider key, the protocol family, the catalogued token limits, and the
 * native effort mapping.
 */
interface Backing {
  providerId: string;
  apiShape: ModelApiShape;
  modelId: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoningLevelMap: Record<string, string>;
}

/**
 * Deliberately spread across all three OpenAI-family quirk clusters, the
 * Anthropic family and the Mistral family — the widest vendor spread the alias
 * swap supports (`ALIASABLE_API_SHAPES`). `openai-codex-responses` is omitted:
 * it is an oauth-subscription protocol and aliases are rejected on oauth
 * credentials at creation, at update and at run launch.
 */
const BACKINGS: Backing[] = [
  {
    providerId: "deepseek",
    apiShape: "openai-completions",
    modelId: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    contextWindow: 131_072,
    maxTokens: 8_192,
    reasoningLevelMap: { high: "high" },
  },
  {
    providerId: "zai",
    apiShape: "openai-completions",
    modelId: "glm-5",
    baseUrl: "https://api.z.ai/api/paas/v4",
    contextWindow: 200_000,
    maxTokens: 32_768,
    reasoningLevelMap: { high: "xhigh" },
  },
  {
    providerId: "openai",
    apiShape: "openai-responses",
    modelId: "gpt-5",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 400_000,
    maxTokens: 128_000,
    reasoningLevelMap: { high: "high", medium: "medium" },
  },
  {
    providerId: "anthropic",
    apiShape: "anthropic-messages",
    modelId: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoningLevelMap: { high: "high", max: "max" },
  },
  {
    providerId: "mistral",
    apiShape: "mistral-conversations",
    modelId: "mistral-large-latest",
    baseUrl: "https://api.mistral.ai",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoningLevelMap: { high: "high" },
  },
];

/** The public identity every one of the backings above hides behind. */
const ALIAS_ID = "appstrate-medium";
const SIDECAR_LLM_URL = "http://sidecar:8080/llm";

/** The env vars `parseRuntimeEnv` requires but `buildRuntimePiEnv` sources elsewhere. */
const SINK = {
  url: "https://appstrate.test/api/runs/run_1/events",
  finalizeUrl: "https://appstrate.test/api/runs/run_1/events/finalize",
  secret: "abcdefghijklmnopqrstuvwxyz0123456789",
};

/**
 * The launcher → container-env → Pi-model chain, for one backing.
 *
 * `modelId` is the ALIAS, exactly as `run-launcher/pi.ts` passes it: the
 * container's `MODEL_ID` is the public id and the real backing id never enters
 * its environment.
 */
function containerModelFor(
  backing: Backing,
  aliased: boolean,
): {
  env: Record<string, string>;
  model: Model<Api>;
} {
  const env = buildRuntimePiEnv({
    model: {
      api: backing.apiShape,
      modelId: aliased ? ALIAS_ID : backing.modelId,
      baseUrl: backing.baseUrl,
      providerId: backing.providerId,
      apiKey: "sk-real-key",
      apiKeyPlaceholder: "sk-placeholder",
      input: ["text"],
      contextWindow: backing.contextWindow,
      maxTokens: backing.maxTokens,
      reasoning: true,
      reasoningLevelMap: backing.reasoningLevelMap,
      cost: { input: 0.28, output: 0.42 },
      aliased,
    },
    agentPrompt: "You are a helpful agent.",
    runId: "run_1",
    sidecarUrl: "http://sidecar:8080",
    sidecarProxyLlmUrl: SIDECAR_LLM_URL,
    sink: SINK,
  });
  return { env, model: buildPiModelFromEnv(parseRuntimeEnv(env)) };
}

/** The request body Pi would actually put on the wire for `model`. */
async function payloadFor(model: Model<Api>): Promise<Record<string, unknown>> {
  let payload: unknown;
  const result = await streamSimple(
    model,
    { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: "sk-placeholder",
      reasoning: "high",
      maxTokens: 4_096,
      // Throwing is how the existing `provider-map.test.ts` harness stops the
      // call before any network I/O: pi-ai turns it into the stream's terminal
      // error, which the assertion below re-checks so a capture that never ran
      // cannot silently pass.
      onPayload: (next: unknown) => {
        payload = next;
        throw new Error("payload captured");
      },
    },
  ).result();
  expect(result.errorMessage).toBe("payload captured");
  return payload as Record<string, unknown>;
}

describe("aliased container env", () => {
  it("names no vendor and binds the canonical dialect", () => {
    for (const backing of BACKINGS) {
      const { env } = containerModelFor(backing, true);
      expect(env.MODEL_API).toBe("pi-messages");
      expect(env.MODEL_ID).toBe(ALIAS_ID);
      // The two variables that named the vendor outright, and the one that
      // spelled out its native effort vocabulary.
      expect(env).not.toHaveProperty("MODEL_PROVIDER");
      expect(env).not.toHaveProperty("MODEL_REASONING_LEVEL_MAP");
      expect(env).not.toHaveProperty("MODEL_COST");
      // Nothing anywhere in the environment spells the backing out.
      const serialized = JSON.stringify(env);
      expect(serialized).not.toContain(backing.providerId);
      expect(serialized).not.toContain(backing.modelId);
      expect(serialized).not.toContain(new URL(backing.baseUrl).hostname);
    }
  });

  it("binds a provider key that names Appstrate, not a vendor", () => {
    for (const backing of BACKINGS) {
      const { model } = containerModelFor(backing, true);
      expect(model.provider).toBe("appstrate");
      expect(model.api).toBe("pi-messages");
      expect(model.baseUrl).toBe(SIDECAR_LLM_URL);
    }
  });
});

describe("aliased container wire shape", () => {
  it("is byte-identical across every backing vendor", async () => {
    const payloads: Array<{ providerId: string; payload: Record<string, unknown> }> = [];
    for (const backing of BACKINGS) {
      const { model } = containerModelFor(backing, true);
      payloads.push({ providerId: backing.providerId, payload: await payloadFor(model) });
    }

    // Compare every backing against the first. Reported with the provider id
    // attached so a failure names WHICH vendor started varying.
    const [reference, ...rest] = payloads;
    for (const other of rest) {
      expect({ providerId: other.providerId, payload: other.payload }).toEqual({
        providerId: other.providerId,
        payload: reference!.payload,
      });
    }

    // Non-vacuity: the identical payload must be a real pi-messages request,
    // not an empty object a broken capture would also make equal. And the
    // model id on it is the ALIAS — pi-messages sends `model: model.id` and
    // nothing else from the record.
    expect(reference!.payload["model"]).toBe(ALIAS_ID);
    expect(reference!.payload).toHaveProperty("context");
    expect(reference!.payload).toHaveProperty("options");
  });

  it("carries only the closed pi-messages vocabulary", async () => {
    // Stated as a WHITELIST rather than a hunt for known vendor field names:
    // the set of vendor spellings is a property of 14 live APIs and nobody can
    // enumerate it, so the assertion that means something is that the request
    // has exactly the three members `pi-messages` defines, with options drawn
    // only from its own portable vocabulary.
    const { model } = containerModelFor(BACKINGS[0]!, true);
    const payload = await payloadFor(model);
    expect(Object.keys(payload).sort()).toEqual(["context", "model", "options"]);

    const options = payload["options"] as Record<string, unknown>;
    const PI_MESSAGES_OPTIONS = [
      "temperature",
      "maxTokens",
      "reasoning",
      "cacheRetention",
      "sessionId",
      "toolChoice",
    ];
    for (const key of Object.keys(options)) expect(PI_MESSAGES_OPTIONS).toContain(key);

    // And the one portable knob that did travel carries the PORTABLE level,
    // not the backing's native mapping of it (`{high: "xhigh"}` for z.ai,
    // `{high: "high"}` for DeepSeek — that table stayed server-side).
    expect(options["reasoning"]).toBe("high");
  });

  it("control: WITHOUT the alias the same table produces vendor-varying payloads", async () => {
    // The gate above is only meaningful if this harness can see vendor
    // variation at all. A non-aliased run keeps the real provider key, so
    // pi-ai's `detectCompat` fires and the two OpenAI-family backings diverge
    // on exactly the fields that motivated `derivePiProvider` in the first
    // place (`developer` role, `max_completion_tokens`).
    const deepseek = await payloadFor(containerModelFor(BACKINGS[0]!, false).model);
    const openaiCompatible = await payloadFor(
      containerModelFor({ ...BACKINGS[0]!, providerId: "openai" }, false).model,
    );
    expect(deepseek).not.toEqual(openaiCompatible);
  });
});
