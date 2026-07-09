// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  buildRuntimePiEnv,
  pickOperatorSidecarEnv,
  SIDECAR_OPERATOR_ENV_KEYS,
} from "../src/container-env.ts";

const model = {
  api: "anthropic-messages",
  modelId: "claude-sonnet-4-5",
  baseUrl: "https://api.anthropic.com",
};

// Sidecar-backed calls must pass the topology explicitly — buildRuntimePiEnv
// throws instead of defaulting (the Docker magic string is gone; the
// orchestrator's sidecarEndpoints is the single topology owner).
const sidecar = { sidecarUrl: "http://sidecar:8080" };

describe("buildRuntimePiEnv", () => {
  it("emits the minimal required set", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "do thing", ...sidecar });
    expect(env.AGENT_PROMPT).toBe("do thing");
    expect(env.MODEL_API).toBe(model.api);
    expect(env.MODEL_ID).toBe(model.modelId);
    expect(env.SIDECAR_URL).toBe("http://sidecar:8080");
  });

  it("throws when a sidecar-backed run omits sidecarUrl", () => {
    expect(() => buildRuntimePiEnv({ model, agentPrompt: "p" })).toThrow(/sidecarUrl is required/);
  });

  it("skips MODEL_BASE_URL when no proxy is configured", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
    expect(env.MODEL_BASE_URL).toBeUndefined();
    expect(env.MODEL_API_KEY).toBeUndefined();
  });

  it("emits AGENT_TIMEOUT_SECONDS only for a positive finite budget", () => {
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar }).AGENT_TIMEOUT_SECONDS,
    ).toBeUndefined();
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, timeoutSeconds: 300 })
        .AGENT_TIMEOUT_SECONDS,
    ).toBe("300");
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, timeoutSeconds: 1.5 })
        .AGENT_TIMEOUT_SECONDS,
    ).toBe("1.5");
    // Non-positive / non-finite budgets are dropped (no enforcement key).
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, timeoutSeconds: 0 })
        .AGENT_TIMEOUT_SECONDS,
    ).toBeUndefined();
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, timeoutSeconds: -5 })
        .AGENT_TIMEOUT_SECONDS,
    ).toBeUndefined();
    expect(
      buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, timeoutSeconds: Infinity })
        .AGENT_TIMEOUT_SECONDS,
    ).toBeUndefined();
  });

  it("never emits a RUN_ENGINE var (single Pi engine)", () => {
    expect(buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar }).RUN_ENGINE).toBeUndefined();
  });

  it("routes LLM traffic through the sidecar when apiKey + proxy url are set", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, apiKey: "sk-ant-secret", apiKeyPlaceholder: "sk-ant-placeholder" },
      agentPrompt: "p",
      ...sidecar,
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
    expect(env.MODEL_API_KEY).toBe("sk-ant-placeholder");
  });

  // P1-12: on the sidecar-proxied path the real provider key must NEVER reach
  // the agent container. A missing apiKeyPlaceholder used to silently fall back
  // to the raw apiKey (`apiKeyPlaceholder ?? apiKey`) — now it fails closed.
  it("throws when sidecar-proxied and apiKey has no placeholder (P1-12)", () => {
    expect(() =>
      buildRuntimePiEnv({
        model: { ...model, apiKey: "sk-test" }, // no apiKeyPlaceholder
        agentPrompt: "p",
        ...sidecar,
        sidecarProxyLlmUrl: "http://sidecar:8080/llm",
      }),
    ).toThrow(/apiKeyPlaceholder is required/);
  });

  // Regression: #741 — a no-sidecar run (static API key, no integrations/proxy)
  // talks to the provider directly, so MODEL_BASE_URL must carry the model's
  // native endpoint. Without it the Pi SDK falls back to api.openai.com and
  // sends an OpenAI-compatible key (DeepSeek/Mistral/z.ai/…) to the wrong host.
  it("emits the model's native baseUrl when the sidecar is skipped (#741)", () => {
    const env = buildRuntimePiEnv({
      model: {
        api: "openai-completions",
        modelId: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-deepseek-secret",
      },
      agentPrompt: "p",
      noSidecar: true,
    });
    expect(env.MODEL_BASE_URL).toBe("https://api.deepseek.com/v1");
    // No-sidecar path hands the real key directly to the agent.
    expect(env.MODEL_API_KEY).toBe("sk-deepseek-secret");
  });

  it("does not emit MODEL_BASE_URL when the sidecar is skipped but baseUrl is empty", () => {
    const env = buildRuntimePiEnv({
      model: { api: "openai-completions", modelId: "gpt-4o", baseUrl: "", apiKey: "sk-x" },
      agentPrompt: "p",
      noSidecar: true,
    });
    // Empty baseUrl → keep the SDK's native default rather than emit "".
    expect(env.MODEL_BASE_URL).toBeUndefined();
  });

  it("prefers the sidecar proxy URL over the model baseUrl when both could apply", () => {
    const env = buildRuntimePiEnv({
      // apiKeyPlaceholder present: sidecar-proxied traffic must carry the
      // placeholder, not the raw key (P1-12) — supply it so this URL-precedence
      // case doesn't trip the fail-closed guard.
      model: {
        ...model,
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-x",
        apiKeyPlaceholder: "ph",
      },
      agentPrompt: "p",
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
      noSidecar: true,
    });
    expect(env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
  });

  it("emits MODEL_INPUT / MODEL_COST / MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS conditionally", () => {
    const env = buildRuntimePiEnv({
      model: {
        ...model,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
        reasoning: true,
        cost: { input: 3, output: 15 },
      },
      agentPrompt: "p",
      ...sidecar,
    });
    expect(env.MODEL_INPUT).toBe(JSON.stringify(["text", "image"]));
    expect(env.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(env.MODEL_MAX_TOKENS).toBe("8192");
    expect(env.MODEL_REASONING).toBe("true");
    expect(env.MODEL_COST).toBe(JSON.stringify({ input: 3, output: 15 }));
  });

  it("omits MODEL_REASONING when null and emits 'false' when explicitly disabled", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, reasoning: null },
      agentPrompt: "p",
      ...sidecar,
    });
    expect(env.MODEL_REASONING).toBeUndefined();

    const env2 = buildRuntimePiEnv({
      model: { ...model, reasoning: false },
      agentPrompt: "p",
      ...sidecar,
    });
    expect(env2.MODEL_REASONING).toBe("false");
  });

  it("serialises OUTPUT_SCHEMA when provided", () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar, outputSchema: schema });
    expect(env.OUTPUT_SCHEMA).toBe(JSON.stringify(schema));
  });

  it("emits HTTP/HTTPS/NO proxy env vars when forward proxy is set", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      ...sidecar,
      forwardProxyUrl: "http://sidecar:8081",
      noProxy: "sidecar,localhost,127.0.0.1",
    });
    expect(env.HTTP_PROXY).toBe("http://sidecar:8081");
    expect(env.HTTPS_PROXY).toBe("http://sidecar:8081");
    expect(env.http_proxy).toBe("http://sidecar:8081");
    expect(env.https_proxy).toBe("http://sidecar:8081");
    expect(env.NO_PROXY).toBe("sidecar,localhost,127.0.0.1");
    expect(env.no_proxy).toBe("sidecar,localhost,127.0.0.1");
  });

  it("throws when forwardProxyUrl is set without noProxy", () => {
    expect(() =>
      buildRuntimePiEnv({
        model,
        agentPrompt: "p",
        ...sidecar,
        forwardProxyUrl: "http://sidecar:8081",
      }),
    ).toThrow(/noProxy is required/);
  });

  it("accepts a custom noProxy list", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      ...sidecar,
      forwardProxyUrl: "http://proxy:3128",
      noProxy: "internal.corp,10.0.0.0/8",
    });
    expect(env.NO_PROXY).toBe("internal.corp,10.0.0.0/8");
  });

  it("does not emit proxy env vars when forwardProxyUrl is unset", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("omits SIDECAR_URL and proxy env vars when noSidecar is true", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      noSidecar: true,
      // Even with forwardProxyUrl supplied, it must be ignored — the
      // forward proxy lives next to the sidecar.
      forwardProxyUrl: "http://sidecar:8081",
    });
    expect(env.SIDECAR_URL).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    // Required keys still emitted.
    expect(env.AGENT_PROMPT).toBe("p");
    expect(env.MODEL_API).toBe(model.api);
    expect(env.MODEL_ID).toBe(model.modelId);
  });

  it("forwards a W3C traceparent into TRACEPARENT when supplied", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      ...sidecar,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("does not emit TRACEPARENT when no parent trace is supplied", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
    expect(env.TRACEPARENT).toBeUndefined();
  });

  it("forwards SIDECAR_MAX_REQUEST_BODY_BYTES to the agent container when set on the host", () => {
    const original = process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    process.env.SIDECAR_MAX_REQUEST_BODY_BYTES = "20971520";
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
      expect(env.SIDECAR_MAX_REQUEST_BODY_BYTES).toBe("20971520");
    } finally {
      if (original === undefined) delete process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
      else process.env.SIDECAR_MAX_REQUEST_BODY_BYTES = original;
    }
  });

  it("forwards TOOL_RESULT_BYTE_LIMIT to the agent container when set on the host", () => {
    const original = process.env.TOOL_RESULT_BYTE_LIMIT;
    process.env.TOOL_RESULT_BYTE_LIMIT = "16384";
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
      expect(env.TOOL_RESULT_BYTE_LIMIT).toBe("16384");
    } finally {
      if (original === undefined) delete process.env.TOOL_RESULT_BYTE_LIMIT;
      else process.env.TOOL_RESULT_BYTE_LIMIT = original;
    }
  });

  it("does not emit TOOL_RESULT_BYTE_LIMIT when unset on the host", () => {
    const original = process.env.TOOL_RESULT_BYTE_LIMIT;
    delete process.env.TOOL_RESULT_BYTE_LIMIT;
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
      expect(env.TOOL_RESULT_BYTE_LIMIT).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.TOOL_RESULT_BYTE_LIMIT = original;
    }
  });

  it("does not emit SIDECAR_MAX_REQUEST_BODY_BYTES when unset on the host", () => {
    const original = process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    delete process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
      expect(env.SIDECAR_MAX_REQUEST_BODY_BYTES).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.SIDECAR_MAX_REQUEST_BODY_BYTES = original;
    }
  });

  it("does not forward SIDECAR_MAX_MCP_ENVELOPE_BYTES through buildRuntimePiEnv (sidecar-only)", () => {
    // The envelope cap is a sidecar-internal concern; the agent runtime
    // never builds JSON-RPC envelopes itself, so forwarding it would be
    // misleading.
    const original = process.env.SIDECAR_MAX_MCP_ENVELOPE_BYTES;
    process.env.SIDECAR_MAX_MCP_ENVELOPE_BYTES = "33554432";
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
      expect(env.SIDECAR_MAX_MCP_ENVELOPE_BYTES).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.SIDECAR_MAX_MCP_ENVELOPE_BYTES;
      else process.env.SIDECAR_MAX_MCP_ENVELOPE_BYTES = original;
    }
  });
});

describe("pickOperatorSidecarEnv", () => {
  // Snapshot/restore helper so each test sees a known starting env.
  function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
    const originals: Record<string, string | undefined> = {};
    for (const key of SIDECAR_OPERATOR_ENV_KEYS) originals[key] = process.env[key];
    try {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("returns an empty record when no keys are set", () => {
    withEnv(
      { SIDECAR_MAX_REQUEST_BODY_BYTES: undefined, SIDECAR_MAX_MCP_ENVELOPE_BYTES: undefined },
      () => {
        expect(pickOperatorSidecarEnv()).toEqual({});
      },
    );
  });

  it("forwards all set keys by default", () => {
    withEnv(
      { SIDECAR_MAX_REQUEST_BODY_BYTES: "20971520", SIDECAR_MAX_MCP_ENVELOPE_BYTES: "33554432" },
      () => {
        expect(pickOperatorSidecarEnv()).toEqual({
          SIDECAR_MAX_REQUEST_BODY_BYTES: "20971520",
          SIDECAR_MAX_MCP_ENVELOPE_BYTES: "33554432",
        });
      },
    );
  });

  it("omits empty-string values (would crash sidecar boot)", () => {
    withEnv(
      { SIDECAR_MAX_REQUEST_BODY_BYTES: "", SIDECAR_MAX_MCP_ENVELOPE_BYTES: "33554432" },
      () => {
        const out = pickOperatorSidecarEnv();
        expect(out.SIDECAR_MAX_REQUEST_BODY_BYTES).toBeUndefined();
        expect(out.SIDECAR_MAX_MCP_ENVELOPE_BYTES).toBe("33554432");
      },
    );
  });

  it("respects the keys argument to filter what is returned", () => {
    withEnv(
      { SIDECAR_MAX_REQUEST_BODY_BYTES: "20971520", SIDECAR_MAX_MCP_ENVELOPE_BYTES: "33554432" },
      () => {
        const out = pickOperatorSidecarEnv(["SIDECAR_MAX_REQUEST_BODY_BYTES"]);
        expect(out).toEqual({ SIDECAR_MAX_REQUEST_BODY_BYTES: "20971520" });
      },
    );
  });
});
