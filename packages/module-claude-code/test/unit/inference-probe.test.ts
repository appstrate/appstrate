// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import claudeCodeModule from "../../src/index.ts";

const def = (claudeCodeModule.modelProviders?.() ?? [])[0]!;

describe("claude-code discovery candidates", () => {
  it("declares modelDiscoveryCandidates ⊇ featuredModels", () => {
    expect(def.modelDiscoveryCandidates).toBeDefined();
    for (const id of def.featuredModels) {
      expect(def.modelDiscoveryCandidates!).toContain(id);
    }
  });
});

describe("claude-code buildInferenceProbe", () => {
  it("sends bearer + version + oauth beta only — no x-api-key, no forged fingerprint", () => {
    const probe = def.hooks?.buildInferenceProbe?.({
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant-oat-test",
    });
    expect(probe).toBeDefined();
    if (!probe || "error" in probe) throw new Error("expected a request, got an error result");
    expect(probe.url).toBe("https://api.anthropic.com/v1/messages");
    expect(probe.method).toBe("POST");
    // Subscription token rides the bearer header (NOT x-api-key).
    expect(probe.headers["Authorization"]).toBe("Bearer sk-ant-oat-test");
    expect(probe.headers["anthropic-beta"]).toContain("oauth");
    expect(probe.headers["anthropic-version"]).toBe("2023-06-01");
    expect(probe.headers["x-api-key"]).toBeUndefined();
    // No Claude Code client-fingerprint forging.
    expect(probe.headers["x-app"]).toBeUndefined();
    expect(probe.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
  });

  it("builds a 1-token request with NO third-party-tier system prelude", () => {
    const probe = def.hooks!.buildInferenceProbe!({
      baseUrl: "https://api.anthropic.com/",
      modelId: "claude-opus-4-8",
      apiKey: "tok",
    });
    if (!probe || "error" in probe) throw new Error("expected a request");
    // Trailing slash on baseUrl must not produce a double slash.
    expect(probe.url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(probe.body) as {
      model: string;
      max_tokens: number;
      system?: unknown;
      messages: unknown[];
    };
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBe(1);
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });
});
