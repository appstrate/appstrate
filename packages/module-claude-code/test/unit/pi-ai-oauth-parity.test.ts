// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { piAiOAuthConfig } from "../../../../scripts/lib/pi-ai-oauth.ts";
import claudeCodeModule from "../../src/index.ts";

describe("claude-code OAuth config", () => {
  it("matches the config pi-ai logs in with", async () => {
    expect(claudeCodeModule.modelProviders?.()[0]?.oauth).toEqual(
      await piAiOAuthConfig("anthropic.js", "SCOPES"),
    );
  });
});
