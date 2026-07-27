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
  });

  it("declares NO oauthWireFormat — forging is removed platform-wide", () => {
    // Real inference runs on the Pi engine (pi-ai emits the provider's
    // subscription request shape, oauth beta header included); the sidecar /
    // chat token resolution only swap the bearer — no anthropic-beta header
    // is added or modified. There is no wire-format forge to declare.
    const cc = claudeCodeModule.modelProviders?.()[0] as Record<string, unknown>;
    expect(cc.oauthWireFormat).toBeUndefined();
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

  it("derives its featured list from the anthropic catalog", () => {
    // The literal ids are NOT asserted here: they are resolved platform-side
    // from the vendored anthropic catalog (see the API suite), which is the
    // whole point — a literal assertion here would be the same rotting
    // snapshot the selector replaced.
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.featuredModels).toEqual({
      catalogFamilies: ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"],
      generations: 1,
    });
  });

  it("declares no identity hook — Anthropic OAuth tokens are not JWTs", () => {
    // Identity comes from the token endpoint response body (the CLI
    // surfaces `email` / `subscriptionType`), not from a self-describing
    // access token. The only hook is `validateCredential` (OFFLINE
    // credential validation — no network) — covered by
    // `inference-probe.test.ts`.
    const cc = claudeCodeModule.modelProviders?.()[0];
    expect(cc?.hooks?.extractTokenIdentity).toBeUndefined();
    expect(cc?.hooks?.validateCredential).toBeFunction();
    expect((cc?.hooks as Record<string, unknown>).buildInferenceProbe).toBeUndefined();
  });
});
