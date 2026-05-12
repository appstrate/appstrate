// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import claudeCodeModule from "../../index.ts";

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
    expect(cc?.forceStream).toBeUndefined();
    expect(cc?.forceStore).toBeUndefined();
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

  it("exposes a non-empty model catalog with recommended seeds", () => {
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.models.length).toBeGreaterThan(0);
    const recommended = cc?.models.filter((m) => m.recommended).map((m) => m.id);
    expect(recommended).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  it("declares no hooks — Anthropic OAuth tokens are not JWTs", () => {
    // Identity comes from the token endpoint response body (the CLI
    // surfaces `email` / `subscriptionType`), not from a self-describing
    // access token. Wire-format quirks live in the sidecar's hardcoded
    // `claude-code` branch (constants in @appstrate/core/sidecar-types).
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.hooks).toBeUndefined();
  });
});
