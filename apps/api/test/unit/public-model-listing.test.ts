// SPDX-License-Identifier: Apache-2.0

/**
 * `publicModelListing`: the credential test and the listing check the key with
 * one minimal chat completion. Loopback upstream (allowlisted by the test
 * preload), so the real guarded transport runs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { registerModelProvider } from "../../src/services/model-providers/registry.ts";
import { testModelConfig } from "../../src/services/org-models.ts";
import { listServedModels } from "../../src/services/model-providers/model-listing.ts";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";

// Pi's OpenCode Go records back the featured ids.
const CATALOG = "opencode-go";
const [FIRST, SECOND] = ["kimi-k2.6", "glm-5.2"] as const;
const PUBLIC_ID = "test-public-listing";
const PRIVATE_ID = "test-private-listing";

function def(providerId: string, overrides: Partial<ModelProviderDefinition>) {
  return {
    providerId,
    displayName: providerId,
    iconUrl: "openai",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://public-listing.example.test/v1",
    baseUrlOverridable: false,
    authMode: "api_key",
    catalogProviderId: CATALOG,
    featuredModels: [FIRST, SECOND],
    ...overrides,
  } satisfies ModelProviderDefinition;
}

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** The listing answers `listingStatus` with `listed`; inference answers `inferenceStatus`. */
let inferenceStatus = 200;
let listingStatus = 200;
let listed: string[] = [FIRST, SECOND];
let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  registerModelProvider(def(PUBLIC_ID, { publicModelListing: true }));
  registerModelProvider(def(PRIVATE_ID, {}));
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json() : null,
      });
      if (path.endsWith("/models")) {
        return Response.json({ data: listed.map((id) => ({ id })) }, { status: listingStatus });
      }
      return Response.json({ error: { type: "status" } }, { status: inferenceStatus });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  seen = [];
  inferenceStatus = 200;
  listingStatus = 200;
  listed = [FIRST, SECOND];
});

const probedModel = () => (seen.find((r) => r.method === "POST")?.body as { model: string }).model;

function config(providerId: string) {
  return { apiShape: "openai-completions", baseUrl, apiKey: "sk-bogus", providerId };
}

describe("testModelConfig — publicModelListing provider", () => {
  it("fails AUTH_FAILED on an inference 401 even though the listing would answer 200", async () => {
    inferenceStatus = 401;
    const result = await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("AUTH_FAILED");
    expect(result.status).toBe(401);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
  });

  it("sends one minimal non-streaming completion on the first listed offered model", async () => {
    await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });

    expect(seen).toHaveLength(2);
    expect(seen[1]!.authorization).toBe("Bearer sk-bogus");
    expect(seen[1]!.body).toEqual({
      model: FIRST,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("accepts the key on 200", async () => {
    const result = await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("accepts the key on a non-auth 4xx — the request got past the key check", async () => {
    inferenceStatus = 400;
    const result = await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(result).toMatchObject({ ok: true, status: 400 });
  });

  it("probes the next listed offered id when the first featured one is retired", async () => {
    listed = ["not-in-the-offer", SECOND];
    await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(probedModel()).toBe(SECOND);
  });

  it("falls back to the first featured id when the listing is unavailable", async () => {
    listingStatus = 503;
    await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(probedModel()).toBe(FIRST);
  });

  it("reports a 429 as RATE_LIMITED, not as an accepted key", async () => {
    inferenceStatus = 429;
    const result = await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(result).toMatchObject({ ok: false, error: "RATE_LIMITED", status: 429 });
  });

  it("reports a 5xx as a provider error, not as an accepted key", async () => {
    inferenceStatus = 503;
    const result = await testModelConfig({ ...config(PUBLIC_ID), modelId: "_test" });
    expect(result).toMatchObject({ ok: false, error: "PROVIDER_ERROR", status: 503 });
  });
});

describe("testModelConfig — provider with an authenticated listing", () => {
  it("keeps validating through GET /models, with no inference call", async () => {
    inferenceStatus = 401;
    const result = await testModelConfig({ ...config(PRIVATE_ID), modelId: "_test" });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });
});

describe("listServedModels — publicModelListing provider", () => {
  it("refuses the listing as AUTH_FAILED when the key fails the inference probe", async () => {
    inferenceStatus = 401;
    const result = await listServedModels(config(PUBLIC_ID));

    expect(result).toMatchObject({ ok: false, error: "AUTH_FAILED", status: 401 });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
  });

  it("refuses the listing as RATE_LIMITED when the probe is throttled", async () => {
    inferenceStatus = 429;
    const result = await listServedModels(config(PUBLIC_ID));
    expect(result).toMatchObject({ ok: false, error: "RATE_LIMITED", status: 429 });
  });

  it("lists the served models once the key passed the probe, reading the listing once", async () => {
    listed = ["not-in-the-offer", SECOND, FIRST];
    const result = await listServedModels(config(PUBLIC_ID));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.map((m) => m.id)).toEqual(["not-in-the-offer", SECOND, FIRST]);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/models",
      "POST /v1/chat/completions",
    ]);
    expect(probedModel()).toBe(SECOND);
  });

  it("leaves a provider with an authenticated listing on the listing alone", async () => {
    inferenceStatus = 401;
    const result = await listServedModels(config(PRIVATE_ID));

    expect(result.ok).toBe(true);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });
});

describe("core providers", () => {
  it("probes OpenRouter keys by inference: its listing answers any key", () => {
    const providers = coreProvidersModule.modelProviders!() as ModelProviderDefinition[];
    expect(providers.find((p) => p.providerId === "openrouter")?.publicModelListing).toBe(true);
  });
});
