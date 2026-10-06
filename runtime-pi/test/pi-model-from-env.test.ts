// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { buildPiModelFromEnv, parseRuntimeEnv } from "../env.ts";

const DIALECT = { name: "DeepSeek V4 Flash", compat: { thinkingFormat: "deepseek" } };

function containerModel(opts: { aliased: boolean; dialect?: typeof DIALECT }) {
  const env = buildRuntimePiEnv({
    model: {
      api: "openai-completions",
      // An id the container's own Pi records under this provider.
      modelId: "deepseek-v4-flash",
      piProvider: "opencode-go",
      dialect: opts.dialect,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      reasoning: true,
      aliased: opts.aliased,
    },
    agentPrompt: "You are a helpful agent.",
    runId: "run_1",
    sidecarUrl: "http://sidecar:8080",
    sidecarAuthToken: "sidecar-auth-token",
    forwardProxyUrl: "http://sidecar:8081",
    noProxy: "sidecar,localhost,127.0.0.1",
    sidecarProxyLlmUrl: "http://sidecar:8080/llm/v1",
    sink: {
      url: "https://appstrate.test/api/runs/run_1/events",
      finalizeUrl: "https://appstrate.test/api/runs/run_1/events/finalize",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  return { env, model: buildPiModelFromEnv(parseRuntimeEnv(env)) };
}

describe("buildPiModelFromEnv — the platform's dialect", () => {
  it("takes the dialect the platform sent and keeps MODEL_ID on the wire", () => {
    const { env, model } = containerModel({ aliased: false, dialect: DIALECT });
    expect(model).toMatchObject({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "opencode-go",
      reasoning: true,
      compat: { thinkingFormat: "deepseek" },
    });
    expect(env.MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("reads no registry of its own: a recorded id the platform sends no dialect for gets none", () => {
    const { env, model } = containerModel({ aliased: false });
    expect(env.MODEL_PROVIDER).toBe("opencode-go");
    expect(env.MODEL_DIALECT).toBe("null");
    expect(model.name).toBe("deepseek-v4-flash");
    expect(model.compat).toEqual(PLATFORM_MODEL_COMPAT);
  });

  it("refuses to boot when a Pi provider comes without a word on the dialect", () => {
    const { MODEL_DIALECT: _absent, ...env } = containerModel({ aliased: false }).env;
    expect(() => parseRuntimeEnv(env)).toThrow(/MODEL_DIALECT: required with MODEL_PROVIDER/);
  });

  it("learns nothing about an alias's backing, even when the alias reads like a model", () => {
    const { env, model } = containerModel({ aliased: true, dialect: DIALECT });
    expect(env.MODEL_PROVIDER).toBeUndefined();
    expect(env).not.toHaveProperty("MODEL_DIALECT");
    expect(model.provider).toBe("appstrate");
    expect(model.compat).toEqual(PLATFORM_MODEL_COMPAT);
  });

  it("refuses to boot on a dialect that is not one", () => {
    const { env } = containerModel({ aliased: false, dialect: DIALECT });
    for (const broken of [
      '{"compat":{}}',
      '{"name":"x","thinkingLevelMap":{"high":1}}',
      "[]",
      "{",
    ]) {
      expect(() => parseRuntimeEnv({ ...env, MODEL_DIALECT: broken })).toThrow(/MODEL_DIALECT/);
    }
  });
});
