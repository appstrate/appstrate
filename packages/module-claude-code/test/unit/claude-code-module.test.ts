// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import claudeCodeModule from "../../src/index.ts";

describe("claude-code module", () => {
  it("declares exactly the claude-code provider", () => {
    const defs = claudeCodeModule.modelProviders?.() ?? [];
    expect(defs).toHaveLength(1);
    expect(defs[0]?.providerId).toBe("claude-code");
  });

  it("uses the anthropic-messages wire shape against api.anthropic.com", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.apiShape).toBe("anthropic-messages");
    expect(cc?.defaultBaseUrl).toBe("https://api.anthropic.com");
    expect(cc?.baseUrlOverridable).toBe(false);
    // No Codex-style stream/store coercion — Anthropic accepts the
    // agent's declared body verbatim.
    expect(cc?.oauthWireFormat?.forceStream).toBeUndefined();
    expect(cc?.oauthWireFormat?.forceStore).toBeUndefined();
  });

  it("OAuth metadata points at platform.claude.com (canonical token host)", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.authMode).toBe("oauth2");
    expect(cc?.oauth?.authorizationUrl).toBe("https://claude.ai/oauth/authorize");
    expect(cc?.oauth?.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(cc?.oauth?.refreshUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(cc?.oauth?.pkce).toBe("S256");
    expect(cc?.oauth?.scopes).toEqual(["org:create_api_key", "user:profile", "user:inference"]);
  });

  it("exposes a non-empty featured catalog", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.featuredModels).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("declares no hooks — Anthropic OAuth tokens are not JWTs", () => {
    // Identity comes from the token endpoint response body (the CLI
    // surfaces `email` / `subscriptionType`), not from a self-describing
    // access token. Wire-format quirks live declaratively on
    // `oauthWireFormat`.
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.hooks).toBeUndefined();
  });

  it("ships the third-party-tier identity prelude verbatim", () => {
    // Paraphrasing this string (even capitalisation) trips Anthropic's
    // third-party tier filter and silently 429s every request.
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.oauthWireFormat?.systemPrepend).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
  });

  it("forces the Claude Code identity headers on every OAuth call", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.oauthWireFormat?.identityHeaders).toEqual({
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    });
  });

  it("declares the long-context adaptive retry policy", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.oauthWireFormat?.adaptiveRetry).toEqual({
      status: 400,
      bodyPatterns: ["out of extra usage", "long context beta not available"],
      headerName: "anthropic-beta",
      removeToken: "context-1m-2025-08-07",
    });
  });
});
