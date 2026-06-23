// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  registerSubscriptionEngine,
  resetSubscriptionEnginesForTesting,
} from "@appstrate/core/subscription-engines";
import { titleRouteForProvider } from "../src/title.ts";

describe("titleRouteForProvider", () => {
  afterEach(() => {
    resetSubscriptionEnginesForTesting();
  });

  it("routes API-key / unregistered providers through the llm-proxy", () => {
    // No subscription engine registered → every provider titles via the proxy.
    expect(titleRouteForProvider("anthropic")).toBe("proxy");
    expect(titleRouteForProvider("openai")).toBe("proxy");
    expect(titleRouteForProvider("mistral")).toBe("proxy");
    expect(titleRouteForProvider(undefined)).toBe("proxy");
  });

  it("hard-skips a chat-capable subscription engine (claude-code)", () => {
    registerSubscriptionEngine({
      providerId: "claude-code",
      label: "Claude Code",
      engine: "claude",
      sidecarAuthMode: "oauth",
      // A chat-capable subscription engine still must NOT title through the
      // generic proxy — its credential only works via the `-sdk` gateway.
      chatHandler: () => new Response("unused"),
    });
    expect(titleRouteForProvider("claude-code")).toBe("skip");
    // Other providers are unaffected — still proxied.
    expect(titleRouteForProvider("anthropic")).toBe("proxy");
  });

  it("hard-skips an agent-only subscription engine (codex, no chatHandler)", () => {
    registerSubscriptionEngine({
      providerId: "codex",
      label: "Codex (ChatGPT)",
      engine: "codex",
      sidecarAuthMode: "vend",
      egressAllowlist: ["chatgpt.com", "openai.com"],
      // No chatHandler — codex is agent-only. The generic proxy resolver has no
      // route for it, so titling MUST skip rather than misroute / silently fail.
    });
    expect(titleRouteForProvider("codex")).toBe("skip");
  });
});
