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
        authMode: "api_key",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test",
        placeholder: "OPENAI_API_KEY",
      } as SidecarLaunchSpec["llm"],
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
      "PI_API_KEY",
      "PI_PLACEHOLDER",
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

  it("ships the (non-forging) oauth llm config as JSON instead of api-key vars", () => {
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
    expect(env.PI_API_KEY).toBeUndefined();
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

  it("extends browser-connect tool calls without overriding operator policy", () => {
    const spec = {
      runToken: "rt_test",
      browserConnectSpec: { browserConnect: {} },
    } as unknown as SidecarLaunchSpec;
    const defaulted: Record<string, string> = {};
    applySpecToSidecarEnv(spec, defaulted);
    expect(defaulted.APPSTRATE_MCP_TOOL_TIMEOUT_MS).toBe("210000");

    const overridden = { APPSTRATE_MCP_TOOL_TIMEOUT_MS: "300000" };
    applySpecToSidecarEnv(spec, overridden);
    expect(overridden.APPSTRATE_MCP_TOOL_TIMEOUT_MS).toBe("300000");
  });
});
