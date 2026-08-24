// SPDX-License-Identifier: Apache-2.0

/**
 * `deriveProviderFromApi` is the single source of truth mapping a Pi
 * `MODEL_API` shape to the Pi SDK `ModelRuntime` provider key. The entrypoint
 * uses it to populate `model.provider`, which the runner then reads verbatim
 * to register + resolve the API key — so this table is the only place the
 * api→provider translation lives.
 */

import { describe, it, expect } from "bun:test";
import {
  deriveProviderFromApi,
  derivePiProvider,
  PI_PROVIDER_BY_MODEL_PROVIDER,
} from "../src/provider-map.ts";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "../src/pi-sdk.ts";

describe("deriveProviderFromApi", () => {
  it("maps each known api shape to its SDK provider key (n→1)", () => {
    expect(deriveProviderFromApi("anthropic-messages")).toBe("anthropic");
    // Codex has its own native provider in Pi 0.84. Mapping it to `openai`
    // silently selects the standard Responses serializer in ModelRuntime.
    expect(deriveProviderFromApi("openai-completions")).toBe("openai");
    expect(deriveProviderFromApi("openai-responses")).toBe("openai");
    expect(deriveProviderFromApi("openai-codex-responses")).toBe("openai-codex");
    expect(deriveProviderFromApi("mistral-conversations")).toBe("mistral");
    expect(deriveProviderFromApi("google-generative-ai")).toBe("google");
    expect(deriveProviderFromApi("google-vertex")).toBe("google-vertex");
    expect(deriveProviderFromApi("azure-openai-responses")).toBe("azure-openai-responses");
    expect(deriveProviderFromApi("bedrock-converse-stream")).toBe("amazon-bedrock");
  });

  it("throws on an unknown api shape rather than guessing", () => {
    expect(() => deriveProviderFromApi("totally-made-up")).toThrow(/unknown model api/i);
    expect(() => deriveProviderFromApi("")).toThrow(/unknown model api/i);
  });
});

/**
 * Pi re-derives each provider's request shape per call from `model.provider`
 * and `model.baseUrl`. Appstrate proxies every platform inference call, so
 * `baseUrl` is ours — the provider key is the only signal left, and these two
 * tests guard the two ways it can stop working: a key Pi no longer knows, and
 * a request that stops matching what the provider natively receives.
 */
describe("derivePiProvider", () => {
  it("maps every backing provider onto a key Pi actually knows", () => {
    const builtin = new Set<string>(getBuiltinProviders());
    for (const [appstrateId, piId] of Object.entries(PI_PROVIDER_BY_MODEL_PROVIDER)) {
      expect({ appstrateId, piId, known: builtin.has(piId) }).toEqual({
        appstrateId,
        piId,
        known: true,
      });
    }
  });

  it("falls back to the api shape's key when the backing is unknown or hidden", () => {
    // `openai-compatible`: a self-hosted OpenAI server IS the generic shape.
    expect(derivePiProvider("openai-compatible", "openai-completions")).toBe("openai");
    // An aliased preset: the platform withholds the backing on purpose.
    expect(derivePiProvider(undefined, "anthropic-messages")).toBe("anthropic");
    // A provider a module added, that Pi has no entry for.
    expect(derivePiProvider("some-module-provider", "openai-completions")).toBe("openai");
  });
});

describe("proxied request shape", () => {
  const base = {
    name: "m",
    api: "openai-completions" as const,
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };

  /** The request body Pi would put on the wire for `m`. */
  async function payloadFor(m: Model<Api>): Promise<Record<string, unknown>> {
    let payload: unknown;
    const result = await streamSimple(
      m,
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: "test-key",
        reasoning: "medium",
        maxTokens: 4_096,
        onPayload: (next: unknown) => {
          payload = next;
          throw new Error("payload captured");
        },
      },
    ).result();
    expect(result.errorMessage).toBe("payload captured");
    return payload as Record<string, unknown>;
  }

  // Regression: with the generic `openai` key the system prompt went out as
  // `role: "developer"` and the cap as `max_completion_tokens`. DeepSeek
  // rejects the first outright — `400 unknown variant 'developer'`, surfaced
  // in chat as "Le modèle a refusé la demande".
  const CASES = [
    {
      name: "deepseek",
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    },
    { name: "zai", providerId: "zai", baseUrl: "https://api.z.ai/api/paas/v4", modelId: "glm-5" },
    { name: "xai", providerId: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" },
    {
      name: "openrouter",
      providerId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "anthropic/claude-sonnet-4.5",
    },
  ];

  // The failure mode itself, pinned: this is exactly what the platform sent
  // for every non-OpenAI provider while `model.provider` came from the api
  // shape alone.
  it("degrades to the generic OpenAI shape when the backing provider is lost", async () => {
    const generic = await payloadFor({
      ...base,
      id: "deepseek-chat",
      provider: deriveProviderFromApi("openai-completions"),
      baseUrl: "https://appstrate.test/api/llm-proxy/openai-completions/v1",
    } as Model<Api>);

    expect((generic["messages"] as Array<{ role: string }>)[0]!.role).toBe("developer");
    expect(generic).toHaveProperty("max_completion_tokens");
  });

  for (const c of CASES) {
    it(`is byte-identical to the native ${c.name} request`, async () => {
      const native = await payloadFor({
        ...base,
        id: c.modelId,
        provider: derivePiProvider(c.providerId, base.api),
        baseUrl: c.baseUrl,
      } as Model<Api>);

      const proxied = await payloadFor({
        ...base,
        // What the platform binds: the upstream model id survives (llm-proxy
        // resolves the preset server-side), the base URL does not.
        id: c.modelId,
        provider: derivePiProvider(c.providerId, base.api),
        baseUrl: "https://appstrate.test/api/llm-proxy/openai-completions/v1",
      } as Model<Api>);

      expect(proxied).toEqual(native);
    });
  }
});
