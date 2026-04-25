// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseRuntimeEnv, RuntimeEnvError } from "../env.ts";

const VALID = {
  AGENT_RUN_ID: "run_test123",
  APPSTRATE_SINK_URL: "https://api.example.com/api/runs/run_test123/events",
  APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/api/runs/run_test123/events/finalize",
  APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
  MODEL_API: "openai-completions",
  MODEL_ID: "gpt-4o-mini",
  AGENT_PROMPT: "You are a helpful agent.",
};

describe("parseRuntimeEnv — happy path", () => {
  it("parses the required minimal env", () => {
    const env = parseRuntimeEnv(VALID);
    expect(env.runId).toBe("run_test123");
    expect(env.modelApi).toBe("openai-completions");
    expect(env.modelId).toBe("gpt-4o-mini");
    expect(env.agentPrompt).toBe("You are a helpful agent.");
    expect(env.sink.url).toBe(VALID.APPSTRATE_SINK_URL);
    expect(env.sink.finalizeUrl).toBe(VALID.APPSTRATE_SINK_FINALIZE_URL);
    expect(env.sink.secret).toBe(VALID.APPSTRATE_SINK_SECRET);
    expect(env.workspaceDir).toBe("/workspace");
    expect(env.heartbeatIntervalMs).toBe(30_000);
    expect(env.modelInput).toEqual(["text"]);
    expect(env.modelCost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(env.modelContextWindow).toBe(128_000);
    expect(env.modelMaxTokens).toBe(16_384);
    expect(env.modelReasoning).toBe(false);
    expect(env.agentInput).toEqual({});
    expect(env.sidecarUrl).toBeUndefined();
    expect(env.modelApiKey).toBeUndefined();
    expect(env.outputSchemaRaw).toBeUndefined();
  });

  it("parses optional fields when set", () => {
    const env = parseRuntimeEnv({
      ...VALID,
      WORKSPACE_DIR: "/agent",
      MODEL_BASE_URL: "https://proxy.example.com/v1",
      MODEL_API_KEY: "sk-test",
      MODEL_REASONING: "true",
      MODEL_INPUT: '["text","image"]',
      MODEL_COST: '{"input":1.5,"output":2.5,"cacheRead":0.5,"cacheWrite":0.7}',
      MODEL_CONTEXT_WINDOW: "200000",
      MODEL_MAX_TOKENS: "32768",
      AGENT_INPUT: '{"foo":"bar","n":1}',
      SIDECAR_URL: "http://sidecar:8080",
      APPSTRATE_HEARTBEAT_INTERVAL_MS: "10000",
      OUTPUT_SCHEMA: '{"type":"object"}',
    });
    expect(env.workspaceDir).toBe("/agent");
    expect(env.modelBaseUrl).toBe("https://proxy.example.com/v1");
    expect(env.modelApiKey).toBe("sk-test");
    expect(env.modelReasoning).toBe(true);
    expect(env.modelInput).toEqual(["text", "image"]);
    expect(env.modelCost).toEqual({ input: 1.5, output: 2.5, cacheRead: 0.5, cacheWrite: 0.7 });
    expect(env.modelContextWindow).toBe(200_000);
    expect(env.modelMaxTokens).toBe(32_768);
    expect(env.agentInput).toEqual({ foo: "bar", n: 1 });
    expect(env.sidecarUrl).toBe("http://sidecar:8080");
    expect(env.heartbeatIntervalMs).toBe(10_000);
    expect(env.outputSchemaRaw).toBe('{"type":"object"}');
  });

  it("forwards a TRACEPARENT env var through to env.traceparent", () => {
    const env = parseRuntimeEnv({
      ...VALID,
      TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(env.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("treats an empty TRACEPARENT as absent", () => {
    const env = parseRuntimeEnv({ ...VALID, TRACEPARENT: "" });
    expect(env.traceparent).toBeUndefined();
  });
});

describe("parseRuntimeEnv — fail-fast errors", () => {
  it("collects every missing required field in one shot", () => {
    let caught: unknown;
    try {
      parseRuntimeEnv({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvError);
    const issues = (caught as RuntimeEnvError).issues;
    expect(issues).toContain("AGENT_RUN_ID: required");
    expect(issues).toContain("APPSTRATE_SINK_URL: required");
    expect(issues).toContain("APPSTRATE_SINK_FINALIZE_URL: required");
    expect(issues).toContain("APPSTRATE_SINK_SECRET: required");
    expect(issues).toContain("MODEL_API: required");
    expect(issues).toContain("MODEL_ID: required");
    expect(issues).toContain("AGENT_PROMPT: required");
  });

  it("rejects non-http sink URL", () => {
    expect(() => parseRuntimeEnv({ ...VALID, APPSTRATE_SINK_URL: "ftp://nope" })).toThrow(
      /APPSTRATE_SINK_URL: must be an http\(s\) URL/,
    );
  });

  it("rejects malformed sink URL", () => {
    expect(() => parseRuntimeEnv({ ...VALID, APPSTRATE_SINK_URL: "not-a-url" })).toThrow(
      /APPSTRATE_SINK_URL/,
    );
  });

  it("rejects too-short sink secret", () => {
    expect(() => parseRuntimeEnv({ ...VALID, APPSTRATE_SINK_SECRET: "short" })).toThrow(
      /APPSTRATE_SINK_SECRET: too short/,
    );
  });

  it("rejects unknown MODEL_API", () => {
    expect(() => parseRuntimeEnv({ ...VALID, MODEL_API: "made-up-api" })).toThrow(
      /MODEL_API: unknown api/,
    );
  });

  it("rejects malformed AGENT_INPUT JSON", () => {
    expect(() => parseRuntimeEnv({ ...VALID, AGENT_INPUT: "not json" })).toThrow(
      /AGENT_INPUT: malformed JSON/,
    );
  });

  it("rejects AGENT_INPUT that isn't an object", () => {
    expect(() => parseRuntimeEnv({ ...VALID, AGENT_INPUT: "[1,2]" })).toThrow(
      /AGENT_INPUT: must be a JSON object/,
    );
  });

  it("rejects malformed MODEL_COST JSON", () => {
    expect(() => parseRuntimeEnv({ ...VALID, MODEL_COST: "{bad}" })).toThrow(
      /MODEL_COST: malformed JSON/,
    );
  });

  it("rejects negative MODEL_COST values", () => {
    expect(() =>
      parseRuntimeEnv({
        ...VALID,
        MODEL_COST: '{"input":-1,"output":0,"cacheRead":0,"cacheWrite":0}',
      }),
    ).toThrow(/MODEL_COST.input/);
  });

  it("rejects malformed MODEL_INPUT", () => {
    expect(() => parseRuntimeEnv({ ...VALID, MODEL_INPUT: '["text","video"]' })).toThrow(
      /MODEL_INPUT: invalid modality "video"/,
    );
  });

  it("rejects non-positive MODEL_CONTEXT_WINDOW", () => {
    expect(() => parseRuntimeEnv({ ...VALID, MODEL_CONTEXT_WINDOW: "0" })).toThrow(
      /MODEL_CONTEXT_WINDOW: must be a positive integer/,
    );
  });

  it("rejects non-numeric heartbeat interval", () => {
    expect(() => parseRuntimeEnv({ ...VALID, APPSTRATE_HEARTBEAT_INTERVAL_MS: "abc" })).toThrow(
      /APPSTRATE_HEARTBEAT_INTERVAL_MS/,
    );
  });

  it("rejects malformed SIDECAR_URL", () => {
    expect(() => parseRuntimeEnv({ ...VALID, SIDECAR_URL: "weird://x" })).toThrow(/SIDECAR_URL/);
  });

  it("error message lists every issue (not just the first)", () => {
    let caught: RuntimeEnvError | undefined;
    try {
      parseRuntimeEnv({
        ...VALID,
        APPSTRATE_SINK_URL: "ftp://x",
        APPSTRATE_SINK_SECRET: "x",
        MODEL_API: "fake",
      });
    } catch (err) {
      caught = err as RuntimeEnvError;
    }
    expect(caught).toBeInstanceOf(RuntimeEnvError);
    expect(caught!.issues.length).toBeGreaterThanOrEqual(3);
    expect(caught!.message).toMatch(/APPSTRATE_SINK_URL/);
    expect(caught!.message).toMatch(/APPSTRATE_SINK_SECRET/);
    expect(caught!.message).toMatch(/MODEL_API/);
  });
});

describe("parseRuntimeEnv — backward-compat with empty strings", () => {
  it("treats empty SIDECAR_URL as unset", () => {
    const env = parseRuntimeEnv({ ...VALID, SIDECAR_URL: "" });
    expect(env.sidecarUrl).toBeUndefined();
  });

  it("treats empty MODEL_BASE_URL as unset", () => {
    const env = parseRuntimeEnv({ ...VALID, MODEL_BASE_URL: "" });
    expect(env.modelBaseUrl).toBeUndefined();
  });

  it("treats empty MODEL_API_KEY as unset", () => {
    const env = parseRuntimeEnv({ ...VALID, MODEL_API_KEY: "" });
    expect(env.modelApiKey).toBeUndefined();
  });
});
