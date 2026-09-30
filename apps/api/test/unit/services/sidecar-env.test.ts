// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { SidecarLaunchSpec } from "@appstrate/core/sidecar-types";
import { applySpecToSidecarEnv } from "../../../src/services/orchestrator/sidecar-env.ts";

describe("applySpecToSidecarEnv", () => {
  it("applies identical spec-driven env from the same spec into different base envs", () => {
    const spec: SidecarLaunchSpec = {
      runToken: "rt_test",
      proxyUrl: "http://proxy.local:8080",
      modelContextWindow: 200_000,
      modelMaxTokens: 8_192,
      llm: {
        authMode: "platform",
        apiShape: "openai-completions",
        baseUrl: "https://api.openai.com",
      },
      integrations: [{ id: "gmail" } as never],
      runtimeTools: ["output", "log"],
      outputSchema: { type: "object" },
    };

    // Mirror the two orchestrators' distinct base envs.
    const dockerEnv: Record<string, string> = { PORT: "8080", RUN_ID: "run_1" };
    const processEnv: Record<string, string> = {
      PORT: "53110",
      INTEGRATION_RUNTIME_ADAPTER: "process",
    };

    applySpecToSidecarEnv(spec, dockerEnv);
    applySpecToSidecarEnv(spec, processEnv);

    // The spec-driven keys must be byte-identical across both targets.
    const specKeys = [
      "PROXY_URL",
      "MODEL_CONTEXT_WINDOW",
      "MODEL_MAX_TOKENS",
      "PI_BASE_URL",
      "PI_LLM_PLATFORM_API_SHAPE",
      "INTEGRATIONS_TO_SPAWN_JSON",
      "RUNTIME_TOOLS_JSON",
      "OUTPUT_SCHEMA",
    ];
    for (const key of specKeys) {
      expect(dockerEnv[key]).toBe(processEnv[key]);
    }

    expect(dockerEnv.PROXY_URL).toBe("http://proxy.local:8080");
    expect(dockerEnv.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(dockerEnv.MODEL_MAX_TOKENS).toBe("8192");
    expect(dockerEnv.PI_BASE_URL).toBe("https://api.openai.com");
    expect(dockerEnv.RUNTIME_TOOLS_JSON).toBe(JSON.stringify(["output", "log"]));
    expect(dockerEnv.OUTPUT_SCHEMA).toBe(JSON.stringify({ type: "object" }));

    // Base-env keys are left untouched (orchestrator-local responsibility).
    expect(dockerEnv.RUN_ID).toBe("run_1");
    expect(processEnv.INTEGRATION_RUNTIME_ADAPTER).toBe("process");
  });

  it("ships the (non-forging) oauth llm config as JSON instead of platform vars", () => {
    const spec: SidecarLaunchSpec = {
      runToken: "rt_test",
      llm: {
        authMode: "oauth",
        baseUrl: "https://api.anthropic.com",
        credentialId: "cred_1",
      } as unknown as SidecarLaunchSpec["llm"],
    };
    const env: Record<string, string> = {};
    applySpecToSidecarEnv(spec, env);

    expect(env.PI_LLM_OAUTH_CONFIG_JSON).toBe(JSON.stringify(spec.llm));
    expect(env.PI_BASE_URL).toBeUndefined();
    expect(env.PI_LLM_PLATFORM_API_SHAPE).toBeUndefined();
  });

  it("ships the platform llm route as a shape, the model's endpoint and a swap", () => {
    const modelSwap = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages" as const,
      backingApiShape: "openai-completions" as const,
      backing: { providerId: "deepseek", input: ["text"] },
    };
    const spec: SidecarLaunchSpec = {
      runToken: "rt_test",
      llm: {
        authMode: "platform",
        apiShape: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        modelSwap,
      },
    };
    const env: Record<string, string> = {};
    applySpecToSidecarEnv(spec, env);

    expect(env.PI_LLM_PLATFORM_API_SHAPE).toBe("openai-completions");
    expect(env.PI_MODEL_SWAP_JSON).toBe(JSON.stringify(modelSwap));
    expect(env.PI_BASE_URL).toBe("https://api.deepseek.com");
    expect(env.PI_LLM_OAUTH_CONFIG_JSON).toBeUndefined();
  });

  it("omits keys for absent optional fields", () => {
    const spec: SidecarLaunchSpec = { runToken: "rt_test" };
    const env: Record<string, string> = {};
    applySpecToSidecarEnv(spec, env);

    expect(env.PROXY_URL).toBeUndefined();
    expect(env.INTEGRATIONS_TO_SPAWN_JSON).toBeUndefined();
    expect(env.OUTPUT_SCHEMA).toBeUndefined();
    expect(env.CONNECT_LOGIN_JSON).toBeUndefined();
    expect(env.CONNECT_RESULT_KEY).toBeUndefined();
  });
});
