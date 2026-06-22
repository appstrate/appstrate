// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SUBSCRIPTION_ENGINES,
  engineForProvider,
  engineHasNativeOutput,
  isSubscriptionEngine,
  subscriptionEngineDef,
} from "../src/subscription-engines.ts";

describe("engineForProvider", () => {
  it("maps the subscription providers to their engines", () => {
    expect(engineForProvider("claude-code")).toBe("claude");
    expect(engineForProvider("codex")).toBe("codex");
  });
  it("falls back to pi for any API-key / unknown provider", () => {
    expect(engineForProvider("openai")).toBe("pi");
    expect(engineForProvider("anthropic")).toBe("pi");
    expect(engineForProvider("")).toBe("pi");
  });
});

describe("subscriptionEngineDef", () => {
  it("exposes the codex egress allowlist (in-container token → locked hosts)", () => {
    expect(subscriptionEngineDef("codex")?.egressAllowlist).toEqual(["chatgpt.com", "openai.com"]);
  });
  it("claude has no egress allowlist (token swapped server-side, never in-container)", () => {
    expect(subscriptionEngineDef("claude-code")?.egressAllowlist).toBeUndefined();
  });
  it("returns undefined for a non-subscription provider", () => {
    expect(subscriptionEngineDef("openai")).toBeUndefined();
  });
  it("carries a human label for each subscription engine", () => {
    expect(subscriptionEngineDef("claude-code")?.label).toBe("Claude Code");
    expect(subscriptionEngineDef("codex")?.label).toBe("Codex");
  });
});

describe("isSubscriptionEngine", () => {
  it("is true for the vendor-binary engines, false for pi", () => {
    expect(isSubscriptionEngine("claude")).toBe(true);
    expect(isSubscriptionEngine("codex")).toBe(true);
    expect(isSubscriptionEngine("pi")).toBe(false);
  });
});

describe("SUBSCRIPTION_ENGINES registry", () => {
  it("has unique provider ids, each a non-pi engine", () => {
    const ids = SUBSCRIPTION_ENGINES.map((d) => d.providerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of SUBSCRIPTION_ENGINES) expect(def.engine).not.toBe("pi");
  });
});

describe("engineHasNativeOutput", () => {
  it("is true only for engines that materialise output natively (claude)", () => {
    // Claude emits the deliverable via the SDK's outputFormat → the launcher
    // must NOT serve it the MCP `output` tool.
    expect(engineHasNativeOutput("claude")).toBe(true);
  });
  it("is false for engines that take output through the MCP tool (codex, pi)", () => {
    expect(engineHasNativeOutput("codex")).toBe(false);
    expect(engineHasNativeOutput("pi")).toBe(false);
  });
});
