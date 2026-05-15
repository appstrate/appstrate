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

describe("buildRuntimePiEnv", () => {
  it("emits the minimal required set", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "do thing" });
    expect(env.AGENT_PROMPT).toBe("do thing");
    expect(env.MODEL_API).toBe(model.api);
    expect(env.MODEL_ID).toBe(model.modelId);
    expect(env.SIDECAR_URL).toBe("http://sidecar:8080");
  });

  it("skips MODEL_BASE_URL when no proxy is configured", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
    expect(env.MODEL_BASE_URL).toBeUndefined();
    expect(env.MODEL_API_KEY).toBeUndefined();
  });

  it("routes LLM traffic through the sidecar when apiKey + proxy url are set", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, apiKey: "sk-ant-secret", apiKeyPlaceholder: "sk-ant-placeholder" },
      agentPrompt: "p",
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
    expect(env.MODEL_API_KEY).toBe("sk-ant-placeholder");
  });

  it("uses the raw apiKey as placeholder when none is provided", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, apiKey: "sk-test" },
      agentPrompt: "p",
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_API_KEY).toBe("sk-test");
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
    });
    expect(env.MODEL_REASONING).toBeUndefined();

    const env2 = buildRuntimePiEnv({
      model: { ...model, reasoning: false },
      agentPrompt: "p",
    });
    expect(env2.MODEL_REASONING).toBe("false");
  });

  it("joins connectedProviders, skipping the key when the list is empty", () => {
    const empty = buildRuntimePiEnv({ model, agentPrompt: "p", connectedProviders: [] });
    expect(empty.CONNECTED_PROVIDERS).toBeUndefined();

    const filled = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      connectedProviders: ["@appstrate/gmail", "@appstrate/clickup"],
    });
    expect(filled.CONNECTED_PROVIDERS).toBe("@appstrate/gmail,@appstrate/clickup");
  });

  it("serialises OUTPUT_SCHEMA when provided", () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", outputSchema: schema });
    expect(env.OUTPUT_SCHEMA).toBe(JSON.stringify(schema));
  });

  it("emits HTTP/HTTPS/NO proxy env vars when forward proxy is set", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      forwardProxyUrl: "http://sidecar:8081",
    });
    expect(env.HTTP_PROXY).toBe("http://sidecar:8081");
    expect(env.HTTPS_PROXY).toBe("http://sidecar:8081");
    expect(env.http_proxy).toBe("http://sidecar:8081");
    expect(env.https_proxy).toBe("http://sidecar:8081");
    expect(env.NO_PROXY).toBe("sidecar,localhost,127.0.0.1");
    expect(env.no_proxy).toBe("sidecar,localhost,127.0.0.1");
  });

  it("accepts a custom noProxy list", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      forwardProxyUrl: "http://proxy:3128",
      noProxy: "internal.corp,10.0.0.0/8",
    });
    expect(env.NO_PROXY).toBe("internal.corp,10.0.0.0/8");
  });

  it("does not emit proxy env vars when forwardProxyUrl is unset", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
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
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("does not emit TRACEPARENT when no parent trace is supplied", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
    expect(env.TRACEPARENT).toBeUndefined();
  });

  it("forwards SIDECAR_MAX_REQUEST_BODY_BYTES to the agent container when set on the host", () => {
    const original = process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    process.env.SIDECAR_MAX_REQUEST_BODY_BYTES = "20971520";
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
      expect(env.SIDECAR_MAX_REQUEST_BODY_BYTES).toBe("20971520");
    } finally {
      if (original === undefined) delete process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
      else process.env.SIDECAR_MAX_REQUEST_BODY_BYTES = original;
    }
  });

  it("does not emit SIDECAR_MAX_REQUEST_BODY_BYTES when unset on the host", () => {
    const original = process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    delete process.env.SIDECAR_MAX_REQUEST_BODY_BYTES;
    try {
      const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
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
      const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
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
