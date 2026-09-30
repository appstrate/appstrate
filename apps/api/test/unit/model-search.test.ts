// SPDX-License-Identifier: Apache-2.0

/**
 * OpenRouter live model search: the mapping of `GET /api/v1/models` to the
 * platform's search result, and the error surface. The backend calls
 * `globalThis.fetch` against a fixed URL, so each test swaps the global and
 * restores the REAL fetch pinned once at module load.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { hasLiveModelSearch, searchOpenRouterModels } from "../../src/services/model-search.ts";
import { ApiError } from "../../src/lib/errors.ts";

const realFetch: typeof fetch = globalThis.fetch;
let requested: { url: string; signal: AbortSignal | null | undefined }[] = [];

function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), signal: init?.signal });
    return respond();
  }) as unknown as typeof fetch;
}

function stubCatalog(data: unknown): void {
  stubFetch(
    () =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  requested = [];
});

describe("hasLiveModelSearch", () => {
  it("is true only for OpenRouter", () => {
    expect(hasLiveModelSearch("openrouter")).toBe(true);
    expect(hasLiveModelSearch("openai")).toBe(false);
    expect(hasLiveModelSearch("")).toBe(false);
  });
});

describe("searchOpenRouterModels", () => {
  it("fetches OpenRouter's catalog with a timeout signal", async () => {
    stubCatalog([]);
    await searchOpenRouterModels("");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(requested[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an OpenRouter entry to a searched model, converting per-token prices to $/M", async () => {
    stubCatalog([
      {
        id: "anthropic/claude-sonnet-4.6",
        name: "Anthropic: Claude Sonnet 4.6",
        context_length: 1_000_000,
        top_provider: { max_completion_tokens: 64_000 },
        architecture: { input_modalities: ["text", "image", "file"] },
        pricing: {
          prompt: "0.000003",
          completion: "0.000015",
          input_cache_read: "0.0000003",
          // Reported by OpenRouter but not mapped: never surfaced.
          input_cache_write: "0.00000375",
        },
      },
    ]);

    const [model] = await searchOpenRouterModels("");
    expect(model!.id).toBe("anthropic/claude-sonnet-4.6");
    expect(model!.name).toBe("Anthropic: Claude Sonnet 4.6");
    expect(model!.contextWindow).toBe(1_000_000);
    expect(model!.maxTokens).toBe(64_000);
    expect(model!.input).toEqual(["text", "image"]);
    expect(model!.reasoning).toBe(false);
    expect(model!.cost!.input).toBeCloseTo(3);
    expect(model!.cost!.output).toBeCloseTo(15);
    expect(model!.cost!.cacheRead).toBeCloseTo(0.3);
    expect(Object.keys(model!.cost!).sort()).toEqual(["cacheRead", "input", "output"]);
  });

  it("maps absent or ill-typed limits to null and text-only input", async () => {
    stubCatalog([
      {
        id: "vendor/bare",
        context_length: "128000",
        top_provider: { max_completion_tokens: null },
        architecture: { input_modalities: ["text"] },
        pricing: { prompt: "0", completion: "0" },
      },
      { id: "vendor/no-architecture", pricing: {} },
    ]);

    const [bare, noArch] = await searchOpenRouterModels("");
    // No name → the id stands in for it.
    expect(bare!.name).toBe("vendor/bare");
    expect(bare!.contextWindow).toBeNull();
    expect(bare!.maxTokens).toBeNull();
    expect(bare!.input).toEqual(["text"]);
    // A free model is a real price of 0, not an unpriced one.
    expect(bare!.cost).toEqual({ input: 0, output: 0 });

    expect(noArch!.input).toEqual(["text"]);
    expect(noArch!.contextWindow).toBeNull();
    expect(noArch!.maxTokens).toBeNull();
    expect(noArch!.cost).toBeNull();
  });

  // OpenRouter publishes `-1` for a variable rate (`openrouter/auto`): not a
  // price, so never a negative cost (which `modelCostSchema` would refuse).
  it("treats a negative published rate as unpublished", async () => {
    stubCatalog([
      { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
      { id: "vendor/neg-output", pricing: { prompt: "0.000001", completion: "-1" } },
      {
        id: "vendor/neg-cache",
        pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "-1" },
      },
    ]);

    const [auto, negOutput, negCache] = await searchOpenRouterModels("");
    expect(auto!.cost).toBeNull();
    expect(negOutput!.cost).toBeNull();
    expect(negCache!.cost!.input).toBeCloseTo(1);
    expect(negCache!.cost!.output).toBeCloseTo(2);
    expect("cacheRead" in negCache!.cost!).toBe(false);
  });

  it("filters by the query on id OR name, case-insensitively", async () => {
    stubCatalog([
      { id: "openai/gpt-5", name: "OpenAI: GPT-5" },
      { id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1" },
      { id: "x-ai/grok-4", name: "xAI: Grok 4 (Sonnet-class)" },
    ]);

    expect((await searchOpenRouterModels("CLAUDE")).map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4.1",
    ]);
    // Matches on the display name only.
    expect((await searchOpenRouterModels("sonnet")).map((m) => m.id)).toEqual(["x-ai/grok-4"]);
    expect(await searchOpenRouterModels("no-such-model")).toEqual([]);
    // A blank query is no filter.
    expect(await searchOpenRouterModels("   ")).toHaveLength(3);
  });

  it("returns at most 50 models", async () => {
    stubCatalog(Array.from({ length: 75 }, (_, i) => ({ id: `vendor/m-${i}` })));
    const models = await searchOpenRouterModels("");
    expect(models).toHaveLength(50);
    expect(models[0]!.id).toBe("vendor/m-0");
    expect(models[49]!.id).toBe("vendor/m-49");
  });

  it("returns no models when the payload carries no data array", async () => {
    stubFetch(() => Response.json({ error: "unexpected" }));
    expect(await searchOpenRouterModels("")).toEqual([]);
  });

  it("maps a non-2xx upstream response to a 502 provider_error", async () => {
    stubFetch(() => new Response("rate limited", { status: 429 }));
    await expectApiError(searchOpenRouterModels(""), 502, "provider_error");
  });

  it("maps an upstream timeout to a 504", async () => {
    stubFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expectApiError(searchOpenRouterModels(""), 504, "timeout");
  });

  it("maps a network failure or unparseable body to a 502 network_error", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expectApiError(searchOpenRouterModels(""), 502, "network_error");

    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    await expectApiError(searchOpenRouterModels(""), 502, "network_error");
  });
});
