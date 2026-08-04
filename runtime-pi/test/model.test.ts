// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseRuntimeEnv } from "../env.ts";
import { buildRuntimeModel } from "../model.ts";

const BASE_ENV = {
  AGENT_RUN_ID: "run_model_test",
  APPSTRATE_SINK_URL: "https://api.example.com/events",
  APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/events/finalize",
  APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
  MODEL_API: "openai-completions",
  MODEL_ID: "deepseek-v4-flash",
  MODEL_BASE_URL: "http://sidecar:8080/llm",
  MODEL_PROVIDER: "deepseek",
  MODEL_REASONING: "true",
  AGENT_PROMPT: "Answer briefly.",
};

describe("buildRuntimeModel", () => {
  it("keeps the upstream provider identity when the request URL is the sidecar", () => {
    const model = buildRuntimeModel(parseRuntimeEnv(BASE_ENV));

    expect(model.provider).toBe("deepseek");
    expect(model.baseUrl).toBe("http://sidecar:8080/llm");
    expect(model.reasoning).toBe(true);
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
  });

  it("falls back to the api-derived auth provider for older launchers", () => {
    const model = buildRuntimeModel(parseRuntimeEnv({ ...BASE_ENV, MODEL_PROVIDER: "" }));

    expect(model.provider).toBe("openai");
  });

  it("keeps native non-compatible API provider keys unchanged", () => {
    const model = buildRuntimeModel(
      parseRuntimeEnv({
        ...BASE_ENV,
        MODEL_API: "openai-codex-responses",
        MODEL_PROVIDER: "codex",
        MODEL_ID: "gpt-5.4",
      }),
    );

    expect(model.provider).toBe("openai");
  });

  it("preserves Moonshot URL-derived compatibility behind the sidecar", () => {
    const model = buildRuntimeModel(
      parseRuntimeEnv({
        ...BASE_ENV,
        MODEL_PROVIDER: "moonshot",
        MODEL_ID: "kimi-k2.5",
      }),
    );

    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    });
  });
});
