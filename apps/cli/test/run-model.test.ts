// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `run` command's model + API-key resolver.
 * Resolves flag > env > default precedence without hitting any LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveModel,
  resolvePresetModel,
  ModelResolutionError,
} from "../src/commands/run/model.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "@appstrate/runner-pi/pi-model";
import { parseModelSource } from "../src/commands/run.ts";
import type { ModelPreset } from "../src/lib/models.ts";

/** Snapshot + wipe env vars touched by the resolver. */
const ENV_KEYS = [
  "APPSTRATE_MODEL_API",
  "APPSTRATE_MODEL_ID",
  "APPSTRATE_LLM_API_KEY",
  "LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
];

let saved: Partial<Record<string, string | undefined>>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveModel — defaults + flags", () => {
  it("defaults to anthropic-messages + claude-sonnet-4-5 when env is empty", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-dev";
    const { model, apiKey } = resolveModel({});
    expect(model.api).toBe("anthropic-messages");
    expect(model.id).toBe("claude-sonnet-4-5");
    expect(model.provider).toBe("anthropic");
    expect(apiKey).toBe("sk-ant-dev");
  });

  it("honours --model / --model-api flags", () => {
    process.env.OPENAI_API_KEY = "sk-openai-dev";
    const { model } = resolveModel({ modelApi: "openai-responses", model: "gpt-5" });
    expect(model.api).toBe("openai-responses");
    expect(model.id).toBe("gpt-5");
    expect(model.provider).toBe("openai");
  });

  it("honours APPSTRATE_MODEL_API / APPSTRATE_MODEL_ID env vars", () => {
    process.env.APPSTRATE_MODEL_API = "mistral-conversations";
    process.env.APPSTRATE_MODEL_ID = "mistral-large";
    process.env.MISTRAL_API_KEY = "mk-dev";
    const { model } = resolveModel({});
    expect(model.api).toBe("mistral-conversations");
    expect(model.id).toBe("mistral-large");
    expect(model.provider).toBe("mistral");
  });

  it("flag beats env var", () => {
    process.env.APPSTRATE_MODEL_API = "anthropic-messages";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.OPENAI_API_KEY = "sk-openai";
    const { model } = resolveModel({ modelApi: "openai-completions" });
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openai");
  });
});

describe("resolveModel — API key resolution", () => {
  it("prefers --llm-api-key flag over env vars", () => {
    process.env.ANTHROPIC_API_KEY = "from-env";
    const { apiKey } = resolveModel({ llmApiKey: "from-flag" });
    expect(apiKey).toBe("from-flag");
  });

  it("uses the provider-specific env var", () => {
    process.env.OPENAI_API_KEY = "sk-openai-specific";
    process.env.LLM_API_KEY = "generic";
    const { apiKey } = resolveModel({ modelApi: "openai-completions" });
    expect(apiKey).toBe("sk-openai-specific");
  });

  it("falls back to APPSTRATE_LLM_API_KEY when no provider key is set", () => {
    process.env.APPSTRATE_LLM_API_KEY = "generic";
    const { apiKey } = resolveModel({});
    expect(apiKey).toBe("generic");
  });

  it("falls back to LLM_API_KEY as a last resort", () => {
    process.env.LLM_API_KEY = "last-resort";
    const { apiKey } = resolveModel({});
    expect(apiKey).toBe("last-resort");
  });

  it("throws ModelResolutionError when no key is available", () => {
    expect(() => resolveModel({})).toThrow(ModelResolutionError);
  });

  it("error message names the expected provider env var", () => {
    try {
      resolveModel({ modelApi: "anthropic-messages" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelResolutionError);
      expect((err as Error).message).toContain("anthropic");
      expect((err as ModelResolutionError).hint).toContain("ANTHROPIC_API_KEY");
    }
  });
});

describe("resolveModel — invalid input", () => {
  it("throws ModelResolutionError on unknown --model-api", () => {
    process.env.ANTHROPIC_API_KEY = "whatever";
    expect(() => resolveModel({ modelApi: "nope" })).toThrow(ModelResolutionError);
  });

  it("error lists accepted model-api values", () => {
    try {
      resolveModel({ modelApi: "nope" });
    } catch (err) {
      expect((err as ModelResolutionError).hint).toContain("anthropic-messages");
      expect((err as ModelResolutionError).hint).toContain("openai-completions");
    }
  });
});

describe("parseModelSource — auto default", () => {
  // Pin the precedence chain so a UX regression in id-mode (UI parity
  // promise: `appstrate run @scope/agent` should mirror clicking Run in
  // the dashboard, no local LLM key needed) fails this test loudly.
  const ENV_KEY = "APPSTRATE_MODEL_SOURCE";
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("auto-picks preset for id-mode + remote (UI parity)", () => {
    expect(parseModelSource(undefined, { autoPreset: true })).toBe("preset");
  });

  it("auto-picks env for path-mode (local-file run)", () => {
    expect(parseModelSource(undefined, { autoPreset: false })).toBe("env");
  });

  it("explicit flag wins over auto-detection", () => {
    expect(parseModelSource("env", { autoPreset: true })).toBe("env");
    expect(parseModelSource("preset", { autoPreset: false })).toBe("preset");
  });

  it("APPSTRATE_MODEL_SOURCE env wins over auto-detection", () => {
    process.env[ENV_KEY] = "env";
    expect(parseModelSource(undefined, { autoPreset: true })).toBe("env");
  });

  it("rejects unknown values with an actionable message", () => {
    expect(() => parseModelSource("bogus")).toThrow(/Unknown --model-source/);
  });
});

describe("resolvePresetModel — proxy routing per protocol", () => {
  // The CLI's preset path routes LLM traffic through `/api/llm-proxy/*` on
  // the pinned instance instead of calling Anthropic/OpenAI directly. Pin
  // the routing + auth shape per protocol so a future preset table mutation
  // doesn't silently send credentials to the wrong host.

  function makePreset(
    overrides: Partial<ModelPreset> & Pick<ModelPreset, "id" | "apiShape">,
  ): ModelPreset {
    return {
      label: overrides.id,
      enabled: true,
      is_default: true,
      needs_reconnection: false,
      source: "built-in",
      providerId: null,
      pi_provider: null,
      pi_dialect: null,
      modelId: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      input: null,
      cost: null,
      ...overrides,
    };
  }

  const PRESET_OPENAI = makePreset({ id: "preset_openai", apiShape: "openai-completions" });
  const PRESET_ANTHROPIC = makePreset({
    id: "preset_anthropic",
    apiShape: "anthropic-messages",
    is_default: false,
  });
  const PRESET_MISTRAL = makePreset({
    id: "preset_mistral",
    apiShape: "mistral-conversations",
    is_default: false,
  });

  it("routes openai-completions through /api/llm-proxy/openai-completions/v1", async () => {
    const { model, apiKey } = await resolvePresetModel({
      profileName: "default",
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      orgId: "org_1",
      presetsLoader: async () => [PRESET_OPENAI],
    });
    expect(model.baseUrl).toBe("https://app.example.com/api/llm-proxy/openai-completions/v1");
    // OpenAI SDK natively sends `Authorization: Bearer <apiKey>`, so the
    // bearer flows in through the SDK's own auth path.
    expect(apiKey).toBe("ask_test");
    expect(model.headers).toEqual({ "X-Org-Id": "org_1" });
  });

  it("routes anthropic-messages through /api/llm-proxy/anthropic-messages with bearer header injection", async () => {
    const { model, apiKey } = await resolvePresetModel({
      profileName: "default",
      modelId: "preset_anthropic",
      instance: "https://app.example.com",
      bearerToken: "ask_test_bearer",
      orgId: "org_1",
      presetsLoader: async () => [PRESET_ANTHROPIC],
    });
    // Anthropic SDK appends `/v1/messages`; baseUrl stops one segment short.
    expect(model.baseUrl).toBe("https://app.example.com/api/llm-proxy/anthropic-messages");
    // pi-ai's Anthropic SDK sends auth as `x-api-key`, but the platform
    // reads `Authorization: Bearer`. We side-channel the bearer via
    // model.headers and pass a placeholder apiKey — the platform's
    // anthropic adapter strips the inbound x-api-key (not in
    // HEADERS_TO_FORWARD) and injects the real upstream key from server
    // storage, so the placeholder never reaches Anthropic.
    expect(model.headers?.["Authorization"]).toBe("Bearer ask_test_bearer");
    expect(model.headers?.["X-Org-Id"]).toBe("org_1");
    expect(apiKey).not.toBe("ask_test_bearer");
    expect(apiKey.length).toBeGreaterThan(0);
  });

  it("routes mistral-conversations through /api/llm-proxy/mistral-conversations", async () => {
    const { model, apiKey } = await resolvePresetModel({
      profileName: "default",
      modelId: "preset_mistral",
      instance: "https://app.example.com",
      bearerToken: "ask_test_mistral",
      orgId: "org_1",
      presetsLoader: async () => [PRESET_MISTRAL],
    });
    // Mistral SDK appends `/v1/chat/completions` → baseUrl is the bare
    // route prefix (no `/v1`), same convention as Anthropic.
    expect(model.baseUrl).toBe("https://app.example.com/api/llm-proxy/mistral-conversations");
    // Mistral's SDK natively sends `Authorization: Bearer <apiKey>` —
    // no header side-channel needed (unlike Anthropic).
    expect(apiKey).toBe("ask_test_mistral");
    expect(model.headers).toEqual({ "X-Org-Id": "org_1" });
    expect(model.provider).toBe("mistral");
  });

  it("never hands pi-ai an OAuth-shaped placeholder for an Anthropic preset", async () => {
    const { apiKey } = await resolvePresetModel({
      profileName: "default",
      modelId: "preset_anthropic_apikey",
      instance: "https://app.example.com",
      bearerToken: "ask_test_apikey",
      orgId: "org_1",
      presetsLoader: async () => [
        makePreset({
          id: "preset_anthropic_apikey",
          apiShape: "anthropic-messages",
          is_default: false,
        }),
      ],
    });
    // The llm-proxy only serves API-key upstreams, so pi-ai's OAuth branch
    // (body reshaping: renamed tools, injected system prompt) must not fire.
    expect(apiKey).not.toContain("sk-ant-oat");
  });

  it("rejects a requested preset whose credential is dead, naming the real reason", async () => {
    // `GET /api/models` now LISTS such a preset instead of hiding it, so the
    // id resolves — without the liveness gate the run would reach the
    // llm-proxy and die there. "No preset matches" would be a lie: it exists.
    await expect(
      resolvePresetModel({
        profileName: "default",
        modelId: "preset_dead",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [
          makePreset({
            id: "preset_dead",
            apiShape: "openai-completions",
            needs_reconnection: true,
          }),
        ],
      }),
    ).rejects.toThrow(/can no longer be used for inference/);
  });

  it("rejects a dead org default rather than reporting no default is set", async () => {
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [
          makePreset({
            id: "preset_dead_default",
            apiShape: "openai-completions",
            needs_reconnection: true,
          }),
        ],
      }),
    ).rejects.toThrow(/preset_dead_default.*can no longer be used/);
  });

  const DEEPSEEK_DIALECT = { name: "DeepSeek V4 Pro", compat: { thinkingFormat: "deepseek" } };

  it("takes the dialect the platform sends", async () => {
    const { model } = await resolvePresetModel({
      profileName: "default",
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      orgId: "org_1",
      presetsLoader: async () => [
        makePreset({
          id: "preset_native",
          apiShape: "openai-completions",
          providerId: "opencode-go",
          pi_provider: "opencode-go",
          pi_dialect: DEEPSEEK_DIALECT,
          // An id no registry records: the dialect is the platform's alone.
          modelId: "deepseek-v9-unreleased",
        }),
      ],
    });
    expect(model).toMatchObject({
      id: "preset_native",
      name: "DeepSeek V4 Pro",
      provider: "opencode-go",
      compat: { thinkingFormat: "deepseek" },
    });
  });

  // `deepseek-v4-pro` is recorded by the CLI's own Pi with a 1M window: read
  // from the platform alone, an unsent limit is the default.
  it("takes its limits from the platform, never from its own registry", async () => {
    const preset = {
      id: "preset_ds",
      apiShape: "openai-completions" as const,
      pi_provider: "opencode-go",
      pi_dialect: DEEPSEEK_DIALECT,
      modelId: "deepseek-v4-pro",
    };
    const resolve = (limits: Partial<ModelPreset>) =>
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [makePreset({ ...preset, ...limits })],
      });
    expect((await resolve({})).model).toMatchObject({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect((await resolve({ contextWindow: 500_000, maxTokens: 16_000 })).model).toMatchObject({
      contextWindow: 500_000,
      maxTokens: 16_000,
    });
  });

  it("refuses an instance that names a Pi provider and sends no dialect", async () => {
    const { pi_dialect: _absent, ...predating } = makePreset({
      id: "preset_old",
      apiShape: "openai-completions",
      pi_provider: "opencode-go",
      modelId: "deepseek-v4-pro",
    });
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [predating as ModelPreset],
      }),
    ).rejects.toThrow(/too old for this CLI/);
  });

  it("refuses a dialect that is not one", async () => {
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [
          makePreset({
            id: "preset_bad",
            apiShape: "openai-completions",
            pi_provider: "opencode-go",
            pi_dialect: { compat: {} } as never,
          }),
        ],
      }),
    ).rejects.toThrow(/malformed `pi_dialect`/);
  });

  it("builds a preset with no `pi_provider` without a record: preset id on the wire, the default limits", async () => {
    const { model } = await resolvePresetModel({
      profileName: "default",
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      orgId: "org_1",
      presetsLoader: async () => [
        makePreset({
          id: "preset_gateway",
          apiShape: "openai-completions",
          providerId: "opencode-go",
          modelId: "deepseek-v4-pro",
        }),
      ],
    });
    expect(model.id).toBe("preset_gateway");
    expect(model.provider).toBe("openai");
    expect(model.compat).not.toHaveProperty("thinkingFormat");
    expect(model.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("rejects unsupported protocols with an actionable hint", async () => {
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [
          makePreset({ id: "preset_codex", apiShape: "openai-codex-responses" }),
        ],
      }),
    ).rejects.toThrow(/openai-codex-responses/);
  });

  it("picks the org default from a GET /api/models body (snake_case `is_default`)", async () => {
    // Raw wire rows, as `listOrgModels` serializes them — not built through
    // `makePreset`, so a client/server spelling drift cannot hide here.
    const body = JSON.parse(`{
      "object": "list",
      "data": [
        { "id": "preset_other", "label": "Other", "apiShape": "openai-completions",
          "providerId": "openai", "enabled": true, "is_default": false,
          "needs_reconnection": false, "source": "built-in" },
        { "id": "preset_default", "label": "Default", "apiShape": "openai-completions",
          "providerId": "openai", "enabled": true, "is_default": true,
          "needs_reconnection": false, "source": "built-in" }
      ]
    }`);
    const { model } = await resolvePresetModel({
      profileName: "default",
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      orgId: "org_1",
      presetsLoader: async () => body.data,
    });
    expect(model.id).toBe("preset_default");
  });

  it("refuses an aliased preset, whose listing nulls its apiShape", async () => {
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [makePreset({ id: "preset_alias", apiShape: null })],
      }),
    ).rejects.toThrow(/preset_alias.*does not route/);
  });
});
