import { describe, test, expect } from "bun:test";
import { buildEnrichedPrompt } from "../prompt-builder.ts";
import type { PromptContext } from "../types.ts";

function baseContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    rawPrompt: "Do the task.",
    tokens: {},
    config: {},
    previousState: null,
    input: {},
    schemas: {},
    providers: [],
    llmModel: "test-model",
    llmConfig: {
      api: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "test-model",
      apiKey: "sk-test",
    },
    ...overrides,
  };
}

describe("buildEnrichedPrompt — provider documentation", () => {
  test("shows PROVIDER.md path when hasProviderDoc is true", () => {
    const ctx = baseContext({
      tokens: { "@test/gmail": "tok" },
      providers: [
        {
          id: "@test/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          hasProviderDoc: true,
          authorizedUris: ["https://gmail.googleapis.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain(".pi/providers/@test/gmail/PROVIDER.md");
    expect(prompt).not.toContain("Documentation: http");
  });

  test("falls back to docsUrl when hasProviderDoc is false", () => {
    const ctx = baseContext({
      tokens: { "@test/stripe": "tok" },
      providers: [
        {
          id: "@test/stripe",
          displayName: "Stripe",
          authMode: "api_key",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          hasProviderDoc: false,
          docsUrl: "https://stripe.com/docs/api",
          authorizedUris: ["https://api.stripe.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Documentation: https://stripe.com/docs/api");
    expect(prompt).not.toContain("PROVIDER.md");
  });

  test("shows nothing when no doc and no docsUrl", () => {
    const ctx = baseContext({
      tokens: { "@test/custom": "tok" },
      providers: [
        {
          id: "@test/custom",
          displayName: "Custom",
          authMode: "api_key",
          credentialHeaderName: "X-Key",
          credentialHeaderPrefix: "",
          authorizedUris: ["https://api.custom.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("PROVIDER.md");
    expect(prompt).not.toContain("Documentation:");
  });
});
