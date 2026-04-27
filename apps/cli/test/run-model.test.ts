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
  "GOOGLE_API_KEY",
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
    overrides: Partial<ModelPreset> & Pick<ModelPreset, "id" | "api">,
  ): ModelPreset {
    return {
      label: overrides.id,
      enabled: true,
      isDefault: true,
      source: "built-in",
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      input: null,
      cost: null,
      ...overrides,
    };
  }

  const PRESET_OPENAI = makePreset({ id: "preset_openai", api: "openai-completions" });
  const PRESET_ANTHROPIC = makePreset({
    id: "preset_anthropic",
    api: "anthropic-messages",
    isDefault: false,
  });
  const PRESET_MISTRAL = makePreset({
    id: "preset_mistral",
    api: "mistral-conversations",
    isDefault: false,
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

  it("routes mistral-conversations through /api/llm-proxy/mistral-conversations/v1", async () => {
    const { model, apiKey } = await resolvePresetModel({
      profileName: "default",
      modelId: "preset_mistral",
      instance: "https://app.example.com",
      bearerToken: "ask_test_mistral",
      orgId: "org_1",
      presetsLoader: async () => [PRESET_MISTRAL],
    });
    // Mistral SDK appends `/chat/completions` → baseUrl carries `/v1`,
    // same convention as OpenAI.
    expect(model.baseUrl).toBe(
      "https://app.example.com/api/llm-proxy/mistral-conversations/v1",
    );
    // Mistral's SDK natively sends `Authorization: Bearer <apiKey>` —
    // no header side-channel needed (unlike Anthropic).
    expect(apiKey).toBe("ask_test_mistral");
    expect(model.headers).toEqual({ "X-Org-Id": "org_1" });
    expect(model.provider).toBe("mistral");
  });

  it("rejects unsupported protocols with an actionable hint", async () => {
    await expect(
      resolvePresetModel({
        profileName: "default",
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        orgId: "org_1",
        presetsLoader: async () => [
          makePreset({ id: "preset_gemini", api: "google-generative-ai" }),
        ],
      }),
    ).rejects.toThrow(/google-generative-ai/);
  });
});
