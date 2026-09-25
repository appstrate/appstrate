// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { buildPiModelFromEnv, parseRuntimeEnv } from "../env.ts";

function containerModel(aliased: boolean) {
  const env = buildRuntimePiEnv({
    model: {
      api: "openai-completions",
      modelId: "deepseek-v4-flash",
      piProvider: "opencode-go",
      apiKey: "sk-real-key",
      apiKeyPlaceholder: "sk-placeholder",
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      aliased,
    },
    agentPrompt: "You are a helpful agent.",
    runId: "run_1",
    sidecarUrl: "http://sidecar:8080",
    sidecarAuthToken: "sidecar-auth-token",
    sidecarProxyLlmUrl: "http://sidecar:8080/llm/v1",
    sink: {
      url: "https://appstrate.test/api/runs/run_1/events",
      finalizeUrl: "https://appstrate.test/api/runs/run_1/events/finalize",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  return { env, model: buildPiModelFromEnv(parseRuntimeEnv(env)) };
}

describe("buildPiModelFromEnv — Pi registry record", () => {
  it("takes the dialect from Pi's record and keeps MODEL_ID on the wire", () => {
    const { env, model } = containerModel(false);
    expect(model).toMatchObject({
      id: "deepseek-v4-flash",
      provider: "opencode-go",
      reasoning: true,
      compat: { thinkingFormat: "deepseek" },
    });
    expect(env.MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("learns nothing about an alias's backing, even when the alias reads like a model", () => {
    const { env, model } = containerModel(true);
    expect(env.MODEL_PROVIDER).toBeUndefined();
    expect(model.provider).toBe("appstrate");
    expect(model.compat).toEqual(PLATFORM_MODEL_COMPAT);
    expect(model.reasoning).toBe(false);
  });
});
