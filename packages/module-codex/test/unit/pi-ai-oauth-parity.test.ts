// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { piAiOAuthConfig } from "../../../../scripts/lib/pi-ai-oauth.ts";
import codexModule from "../../src/index.ts";

describe("codex OAuth config", () => {
  it("matches the config pi-ai logs in with", async () => {
    expect(codexModule.modelProviders?.()[0]?.oauth).toEqual(
      await piAiOAuthConfig("openai-codex.js", "SCOPE"),
    );
  });
});
