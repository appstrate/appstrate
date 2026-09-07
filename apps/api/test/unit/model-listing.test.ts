// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `parseServedModels` — the pure half of model listing — plus the
 * one `listServedModels` verdict reachable without a network: a base URL the
 * egress guard refuses. The rest of the network half is covered where it is
 * used, through the injected `listModels` dependency of
 * `discoverAvailableModels`.
 */

import { describe, it, expect } from "bun:test";
import {
  listServedModels,
  parseServedModels,
} from "../../src/services/model-providers/model-listing.ts";

const DATA_SHAPES = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "mistral-conversations",
  "anthropic-messages",
  "some-unknown-shape",
];

/** Ids only — the shape assertions below are about the container, not the hints. */
function ids(models: { id: string }[] | null): string[] | null {
  return models?.map((m) => m.id) ?? null;
}

describe("parseServedModels", () => {
  for (const apiShape of DATA_SHAPES) {
    it(`${apiShape}: reads ids from { data: [{ id }] } in response order`, () => {
      expect(
        ids(
          parseServedModels(apiShape, {
            data: [{ id: "gpt-5" }, { id: "gpt-4o", display_name: "GPT-4o" }],
          }),
        ),
      ).toEqual(["gpt-5", "gpt-4o"]);
    });
  }

  it("google-generative-ai: strips the `models/` prefix from `name`", () => {
    expect(
      ids(
        parseServedModels("google-generative-ai", {
          models: [{ name: "models/gemini-3-pro" }, { name: "models/gemini-3-flash" }],
        }),
      ),
    ).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("google-vertex: reads the same shape and leaves an unprefixed name alone", () => {
    expect(
      ids(
        parseServedModels("google-vertex", {
          models: [{ name: "models/gemini-3-pro" }, { name: "gemini-3-flash" }],
        }),
      ),
    ).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("google shapes ignore a `data` array (and vice versa)", () => {
    expect(parseServedModels("google-vertex", { data: [{ id: "gpt-5" }] })).toBeNull();
    expect(parseServedModels("openai-responses", { models: [{ name: "m" }] })).toBeNull();
  });

  it("dedupes, keeping the first occurrence and its hints", () => {
    expect(
      parseServedModels("openai-responses", {
        data: [{ id: "a", max_model_len: 4096 }, { id: "b" }, { id: "a", max_model_len: 8192 }],
      }),
    ).toEqual([
      { id: "a", hints: { contextWindow: 4096 } },
      { id: "b", hints: {} },
    ]);
  });

  it("caps a runaway listing at 1000 models", () => {
    const data = Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}` }));
    const models = parseServedModels("openai-responses", { data });
    expect(models).toHaveLength(1000);
    expect(models?.[999]?.id).toBe("m-999");
  });

  it("accepts an empty listing as an empty list, not an unreadable one", () => {
    expect(parseServedModels("openai-responses", { data: [] })).toEqual([]);
    expect(parseServedModels("google-vertex", { models: [] })).toEqual([]);
  });

  it("returns null for a body that is not an object", () => {
    for (const body of [null, undefined, "models", 42, [{ id: "a" }]]) {
      expect(parseServedModels("openai-responses", body)).toBeNull();
    }
  });

  it("returns null when the array is missing or not an array", () => {
    expect(parseServedModels("openai-responses", {})).toBeNull();
    expect(parseServedModels("openai-responses", { data: { id: "a" } })).toBeNull();
    expect(parseServedModels("google-generative-ai", {})).toBeNull();
  });

  it("skips entries with no usable id and keeps the readable ones", () => {
    expect(
      ids(
        parseServedModels("openai-responses", {
          data: [{ id: "a" }, { id: 7 }, "b", null, { display_name: "no id" }, { id: "c" }],
        }),
      ),
    ).toEqual(["a", "c"]);
    expect(
      ids(parseServedModels("google-vertex", { models: [{ id: "a" }, { name: "m" }] })),
    ).toEqual(["m"]);
  });

  it("skips an empty id (or one that is nothing but the `models/` prefix)", () => {
    expect(parseServedModels("openai-responses", { data: [{ id: "" }] })).toEqual([]);
    expect(parseServedModels("openai-responses", { data: [{}] })).toEqual([]);
    expect(
      ids(
        parseServedModels("google-vertex", { models: [{ name: "models/" }, { name: "models/m" }] }),
      ),
    ).toEqual(["m"]);
  });
});

describe("parseServedModels hints", () => {
  /** One entry through the parser — the sniffing is what is under test. */
  function hintsOf(entry: Record<string, unknown>): unknown {
    return parseServedModels("openai-completions", { data: [entry] })?.[0]?.hints;
  }

  it("plain OpenAI: an entry that publishes nothing carries no hint", () => {
    expect(
      hintsOf({ id: "gpt-4o", object: "model", created: 1715367049, owned_by: "system" }),
    ).toEqual({});
  });

  it("vLLM: reads max_model_len", () => {
    expect(
      hintsOf({ id: "meta-llama/Llama-3.1-8B-Instruct", object: "model", max_model_len: 131072 }),
    ).toEqual({ contextWindow: 131072 });
  });

  it("Mistral: reads capabilities.vision and capabilities.reasoning", () => {
    expect(
      hintsOf({
        id: "mistral-medium-latest",
        max_context_length: 131072,
        capabilities: { completion_chat: true, vision: true, function_calling: true },
      }),
    ).toEqual({ contextWindow: 131072, input: ["text", "image"] });

    expect(
      hintsOf({ id: "magistral-small", capabilities: { vision: false, reasoning: true } }),
    ).toEqual({ input: ["text"], reasoning: true });
  });

  it("OpenRouter: reads context_length, top_provider and architecture/supported_parameters", () => {
    expect(
      hintsOf({
        id: "openai/gpt-5",
        context_length: 400000,
        architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
        top_provider: { context_length: 400000, max_completion_tokens: 128000 },
        supported_parameters: ["max_tokens", "reasoning", "tools"],
      }),
    ).toEqual({
      contextWindow: 400000,
      maxTokens: 128000,
      input: ["text", "image"],
      reasoning: true,
    });
  });

  it("LM Studio: reads max_context_length", () => {
    expect(
      hintsOf({ id: "qwen3-8b", object: "model", type: "llm", max_context_length: 40960 }),
    ).toEqual({ contextWindow: 40960 });
  });

  it("takes the first positive context window and ignores a non-positive one", () => {
    expect(hintsOf({ id: "m", max_model_len: 8192, context_length: 4096 })).toEqual({
      contextWindow: 8192,
    });
    expect(hintsOf({ id: "m", max_model_len: 0, context_length: 4096 })).toEqual({
      contextWindow: 4096,
    });
  });

  it("reads max_output_tokens when there is no top_provider", () => {
    expect(hintsOf({ id: "m", max_output_tokens: 8192 })).toEqual({ maxTokens: 8192 });
  });

  it("leaves a key absent when the value has the wrong type", () => {
    expect(
      hintsOf({
        id: "m",
        max_model_len: "131072",
        context_length: 4096.5,
        max_output_tokens: null,
        top_provider: "openai",
        architecture: { input_modalities: "text" },
        capabilities: { vision: "yes", reasoning: 1 },
        supported_parameters: "reasoning",
      }),
    ).toEqual({});
  });

  it("ignores modalities it does not model, and falls back to nothing when none match", () => {
    expect(hintsOf({ id: "m", architecture: { input_modalities: ["text", "audio"] } })).toEqual({
      input: ["text"],
    });
    expect(hintsOf({ id: "m", architecture: { input_modalities: ["audio"] } })).toEqual({});
  });
});

describe("listServedModels", () => {
  it("keeps the BLOCKED_URL verdict distinct from an unreachable provider", async () => {
    // The egress guard refuses the link-local metadata address before any
    // socket is opened; the operator lifts such a refusal with
    // EGRESS_ALLOW_INTERNAL_HOSTS, so the caller must be able to tell it from
    // "the provider did not answer". (Loopback would not do: the test preload
    // puts 127.0.0.1 on that very allowlist.)
    const result = await listServedModels({
      apiShape: "openai-responses",
      baseUrl: "http://169.254.169.254/v1",
      apiKey: "k",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("BLOCKED_URL");
  });
});
