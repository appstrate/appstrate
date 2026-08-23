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
  it("forwards explicit generation controls, including temperature zero", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      ...sidecar,
      generation: { temperature: 0, reasoningLevel: "xhigh" },
    });
    expect(env.MODEL_TEMPERATURE).toBe("0");
    expect(env.MODEL_REASONING_LEVEL).toBe("xhigh");
  });

  it("forwards provider-native reasoning level mappings", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, reasoningLevelMap: { xhigh: "max" } },
      agentPrompt: "p",
      ...sidecar,
    });
    expect(env.MODEL_REASONING_LEVEL_MAP).toBe('{"xhigh":"max"}');
  });

  it("omits generation controls to preserve Pi/provider defaults", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
    expect(env.MODEL_TEMPERATURE).toBeUndefined();
    expect(env.MODEL_REASONING_LEVEL).toBeUndefined();
  });

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

  // Regression: a sidecar-proxied run replaces MODEL_BASE_URL with the
  // sidecar's URL, one of the two inputs Pi derives a provider's request shape
  // from. With only the api shape left, the container emitted plain-OpenAI
  // bytes at every provider and DeepSeek answered 400 (`unknown variant
  // 'developer'`). The real provider key travels instead.
  it("names the backing provider so the container keeps Pi's provider detection", () => {
    const env = buildRuntimePiEnv({
      model: {
        api: "openai-completions",
        modelId: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        providerId: "deepseek",
        apiKey: "sk-secret",
        apiKeyPlaceholder: "sk-placeholder",
      },
      agentPrompt: "p",
      ...sidecar,
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_PROVIDER).toBe("deepseek");
    // The binding the sidecar exists to hide stays out of the container.
    expect(env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
    expect(env.MODEL_API_KEY).toBe("sk-placeholder");
  });

  it("omits the provider key when the caller does not know the backing", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", ...sidecar });
    expect(env.MODEL_PROVIDER).toBeUndefined();
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

  describe("model-alias masking (issue #1198, Threat B)", () => {
    // The env an aliased run is built from. The backing here is a real
    // 200 000/8192 catalog pair — the exact shape an org member who printed the
    // container env could look up.
    const aliasedModel = {
      ...model,
      aliased: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 8192,
      reasoning: true,
      cost: { input: 3, output: 15 },
    };

    it("omits MODEL_COST — the published rate card names the vendor", () => {
      const env = buildRuntimePiEnv({ model: aliasedModel, agentPrompt: "p", ...sidecar });
      expect(env).not.toHaveProperty("MODEL_COST");
      // Safe only because the ledger stopped depending on it: the runner row's
      // `cost_usd` is computed server-side from `runs.model_cost` × the
      // reported token counts (`writeRunnerLedgerRow`).
    });

    it("rounds the token limits DOWN onto the alias ladder", () => {
      const env = buildRuntimePiEnv({ model: aliasedModel, agentPrompt: "p", ...sidecar });
      expect(env.MODEL_CONTEXT_WINDOW).toBe("196608");
      // 8192 is already a rung; rounding never moves a value that sits on one.
      expect(env.MODEL_MAX_TOKENS).toBe("8192");
      expect(Number(env.MODEL_CONTEXT_WINDOW)).toBeLessThan(200_000);
      expect(Number(env.MODEL_MAX_TOKENS)).toBeLessThanOrEqual(8192);
    });

    it("keeps MODEL_INPUT — dropping it silently disables image input", () => {
      // `parseModelInput` falls back to `["text"]` on an absent var, so masking
      // the modality vector would degrade the run rather than hide anything the
      // read projection does not already publish.
      const env = buildRuntimePiEnv({ model: aliasedModel, agentPrompt: "p", ...sidecar });
      expect(env.MODEL_INPUT).toBe(JSON.stringify(["text", "image"]));
    });

    it("never rounds up, and never yields MODEL_MAX_TOKENS >= MODEL_CONTEXT_WINDOW", () => {
      // The close pair is the one that would: independently rounded, 197 000
      // and 200 000 both land on 196 608, and a cap equal to the window sends
      // `deriveResponseReserveTokens` to its corrupt-data fallback.
      const env = buildRuntimePiEnv({
        model: { ...aliasedModel, contextWindow: 200_000, maxTokens: 197_000 },
        agentPrompt: "p",
        ...sidecar,
      });
      expect(Number(env.MODEL_CONTEXT_WINDOW)).toBeLessThanOrEqual(200_000);
      expect(Number(env.MODEL_MAX_TOKENS)).toBeLessThanOrEqual(197_000);
      expect(Number(env.MODEL_MAX_TOKENS)).toBeLessThan(Number(env.MODEL_CONTEXT_WINDOW));
    });

    it("leaves a NON-aliased run byte-for-byte as it was", () => {
      // A BYOK model the org configured itself has nothing to hide — the org
      // already knows its own binding.
      const { aliased: _aliased, ...byokModel } = aliasedModel;
      const byok = buildRuntimePiEnv({ model: byokModel, agentPrompt: "p", ...sidecar });
      const explicitlyNotAliased = buildRuntimePiEnv({
        model: { ...aliasedModel, aliased: false },
        agentPrompt: "p",
        ...sidecar,
      });
      expect(explicitlyNotAliased).toEqual(byok);
      expect(byok.MODEL_CONTEXT_WINDOW).toBe("200000");
      expect(byok.MODEL_MAX_TOKENS).toBe("8192");
      expect(byok.MODEL_COST).toBe(JSON.stringify({ input: 3, output: 15 }));
    });
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
  //
  // It CLEARS every listed key before applying the caller's overrides, rather
  // than only the keys the caller names. The tests below assert an exact shape,
  // so any listed key that happens to be set in the ambient environment would
  // otherwise leak into the result — which is exactly what happened when
  // `LOG_LEVEL` joined `SIDECAR_OPERATOR_ENV_KEYS` (it is set by nearly every
  // shell and by `.env`). Clearing the whole list keeps the isolation correct
  // for whatever key is added next, instead of loosening the assertions.
  function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
    const originals: Record<string, string | undefined> = {};
    for (const key of SIDECAR_OPERATOR_ENV_KEYS) {
      originals[key] = process.env[key];
      delete process.env[key];
    }
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

  // Regression: three of these keys (LOG_LEVEL aside) were added to
  // SIDECAR_OPERATOR_ENV_KEYS in this sweep. Before that they were never
  // forwarded in container mode, and `.env.example` told operators outright
  // that setting them "has NO effect". The sidecar parses them with
  // `readPositiveIntEnv`, which THROWS at module scope on the boot path — so
  // forwarding a stale `=0` or `=100_000` someone set while it was documented
  // as inert would have killed the sidecar and failed every run.
  it("omits malformed numeric values instead of crashing the sidecar at boot", () => {
    for (const bad of ["0", "-1", "100_000", "200k", "8000.5", "NaN", "1e3x"]) {
      withEnv({ SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS: bad }, () => {
        expect(pickOperatorSidecarEnv().SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS).toBeUndefined();
      });
    }
  });

  it("still forwards well-formed numeric values", () => {
    withEnv(
      {
        SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS: "100000",
        SIDECAR_INLINE_TOOL_OUTPUT_TOKENS: "8000",
        SIDECAR_API_CALL_CONCURRENCY: "4",
      },
      () => {
        expect(pickOperatorSidecarEnv()).toEqual({
          SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS: "100000",
          SIDECAR_INLINE_TOOL_OUTPUT_TOKENS: "8000",
          SIDECAR_API_CALL_CONCURRENCY: "4",
        });
      },
    );
  });

  // The gate must be no stricter than the sidecar's own parse, or it would
  // silently drop values the sidecar would have honoured. `Number` trims, so
  // padded input is valid on BOTH sides — asserted here because the two live
  // in different processes and nothing else pins them together.
  it("forwards padded numerics, matching the sidecar's own Number() parse", () => {
    withEnv({ SIDECAR_API_CALL_CONCURRENCY: " 4 " }, () => {
      expect(pickOperatorSidecarEnv().SIDECAR_API_CALL_CONCURRENCY).toBe(" 4 ");
    });
  });

  // Non-numeric keys are untouched: the sidecar either uses them verbatim or
  // already degrades safely, so filtering them would only lose information.
  it("leaves non-numeric keys alone, however odd their value", () => {
    withEnv({ LOG_LEVEL: "not-a-level", RUNNER_IMAGE_NODE: "ghcr.io/x/node:1.2.3" }, () => {
      const out = pickOperatorSidecarEnv();
      expect(out.LOG_LEVEL).toBe("not-a-level");
      expect(out.RUNNER_IMAGE_NODE).toBe("ghcr.io/x/node:1.2.3");
    });
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
