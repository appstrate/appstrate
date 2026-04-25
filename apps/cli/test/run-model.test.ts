// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `run` command's model + API-key resolver.
 * Resolves flag > env > default precedence without hitting any LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveModel, ModelResolutionError } from "../src/commands/run/model.ts";

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
