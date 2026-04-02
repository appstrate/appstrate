// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildEnrichedPrompt } from "../../src/services/adapters/prompt-builder.ts";
import type { PromptContext } from "../../src/services/adapters/types.ts";

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

/** Context with all system tools available (mimics backward compat behavior). */
function contextWithSystemTools(overrides?: Partial<PromptContext>): PromptContext {
  return baseContext({
    availableTools: [
      { id: "@appstrate/log", name: "Log", description: "Send progress messages" },
      { id: "@appstrate/output", name: "Output", description: "Return execution result" },
      { id: "@appstrate/set-state", name: "Set State", description: "Persist state" },
      { id: "@appstrate/add-memory", name: "Add Memory", description: "Save a memory" },
    ],
    ...overrides,
  });
}

// ─── Core structure ─────────────────────────────────────────

describe("buildEnrichedPrompt — core structure", () => {
  it("includes system identity section", () => {
    const prompt = buildEnrichedPrompt(baseContext());
    expect(prompt).toContain("## System");
    expect(prompt).toContain("Appstrate platform");
    expect(prompt).toContain("ephemeral container");
  });

  it("appends raw prompt at the end after separator", () => {
    const ctx = baseContext({ rawPrompt: "My custom task instruction." });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("---\n\nMy custom task instruction.");
    // Raw prompt should be at the very end
    expect(prompt.endsWith("My custom task instruction.")).toBe(true);
  });

  it("includes timeout when specified", () => {
    const ctx = baseContext({ timeout: 120 });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("120 seconds");
  });

  it("omits timeout when not specified", () => {
    const ctx = baseContext({ timeout: undefined });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("**Timeout**");
  });
});

// ─── Tool documentation (TOOL.md) ──────────────────────────

describe("buildEnrichedPrompt — tool documentation", () => {
  it("includes TOOL.md content for available tools", () => {
    const ctx = baseContext({
      availableTools: [
        { id: "@appstrate/log", name: "Log", description: "Send progress messages" },
      ],
      toolDocs: [{ id: "@appstrate/log", content: "## User Communication\n\nUse the `log` tool." }],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## User Communication");
    expect(prompt).toContain("Use the `log` tool.");
  });

  it("includes multiple tool docs", () => {
    const ctx = baseContext({
      availableTools: [
        { id: "@appstrate/set-state", name: "Set State", description: "Persist state" },
        { id: "@appstrate/add-memory", name: "Add Memory", description: "Save a memory" },
      ],
      toolDocs: [
        { id: "@appstrate/set-state", content: "## State Persistence\n\nUse `set_state`." },
        { id: "@appstrate/add-memory", content: "## Memory\n\nUse `add_memory`." },
      ],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## State Persistence");
    expect(prompt).toContain("## Memory");
  });

  it("omits tool doc section when no toolDocs", () => {
    const ctx = baseContext({ toolDocs: undefined });
    const prompt = buildEnrichedPrompt(ctx);
    // Should not contain any tool-specific documentation sections
    expect(prompt).not.toContain("## User Communication");
    expect(prompt).not.toContain("## State Persistence");
  });
});

// ─── User input ─────────────────────────────────────────────

describe("buildEnrichedPrompt — user input", () => {
  it("includes user input values", () => {
    const ctx = baseContext({
      input: { topic: "AI safety", depth: "detailed" },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## User Input");
    expect(prompt).toContain("topic");
    expect(prompt).toContain("AI safety");
    expect(prompt).toContain("depth");
    expect(prompt).toContain("detailed");
  });

  it("includes schema descriptions for input fields", () => {
    const ctx = baseContext({
      input: { topic: "AI" },
      schemas: {
        input: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Main research topic" },
          },
          required: ["topic"],
        },
      },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Main research topic");
    expect(prompt).toContain("required");
  });

  it("omits input section when no input provided", () => {
    const ctx = baseContext({ input: {} });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## User Input");
  });

  it("excludes file-type input fields from user input section", () => {
    const ctx = baseContext({
      input: { text: "hello", document: "file-ref" },
      schemas: {
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            document: {
              type: "string",
              format: "uri",
              contentMediaType: "application/octet-stream",
            },
          },
        },
      },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("text");
    // file type should be excluded from User Input
  });
});

// ─── Configuration ──────────────────────────────────────────

describe("buildEnrichedPrompt — configuration", () => {
  it("includes config values", () => {
    const ctx = baseContext({
      config: { language: "fr", maxResults: 10 },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Configuration");
    expect(prompt).toContain("language");
    expect(prompt).toContain("fr");
    expect(prompt).toContain("maxResults");
  });

  it("includes schema descriptions for config fields", () => {
    const ctx = baseContext({
      config: { language: "fr" },
      schemas: {
        config: {
          type: "object",
          properties: {
            language: { type: "string", description: "Output language" },
          },
          required: ["language"],
        },
      },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Output language");
    expect(prompt).toContain("required");
  });

  it("omits configuration section when no config", () => {
    const ctx = baseContext({ config: {} });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Configuration");
  });
});

// ─── Previous state ─────────────────────────────────────────

describe("buildEnrichedPrompt — previous state", () => {
  it("includes previous state when set-state tool is available", () => {
    const ctx = contextWithSystemTools({
      previousState: { cursor: "abc123", processedCount: 42 },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Previous State");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"cursor": "abc123"');
    expect(prompt).toContain('"processedCount": 42');
  });

  it("omits previous state when null", () => {
    const ctx = contextWithSystemTools({ previousState: null });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Previous State");
  });

  it("includes previous state regardless of available tools", () => {
    const ctx = baseContext({
      previousState: { cursor: "abc123" },
      availableTools: [],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Previous State");
    expect(prompt).toContain("abc123");
  });
});

// ─── Memories ───────────────────────────────────────────────

describe("buildEnrichedPrompt — memories", () => {
  it("includes memories section when add-memory tool is available", () => {
    const ctx = contextWithSystemTools({
      memories: [
        { id: 1, content: "Gmail API paginates at 100 results", createdAt: "2025-01-15" },
        { id: 2, content: "Use batch endpoint for efficiency", createdAt: "2025-01-16" },
      ],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Gmail API paginates at 100 results");
    expect(prompt).toContain("Use batch endpoint for efficiency");
    expect(prompt).toContain("2025-01-15");
  });

  it("omits memory section when no memories", () => {
    const ctx = contextWithSystemTools({ memories: [] });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Memory");
  });

  it("includes memories regardless of available tools", () => {
    const ctx = baseContext({
      memories: [{ id: 1, content: "Some memory", createdAt: "2025-01-15" }],
      availableTools: [],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Some memory");
  });
});

// ─── Run history API ────────────────────────────────────────

describe("buildEnrichedPrompt — run history", () => {
  it("includes run history API when runApi provided", () => {
    const ctx = baseContext({
      runApi: { url: "http://platform:3000", token: "exec_token_123" },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Run History");
    expect(prompt).toContain("$SIDECAR_URL/execution-history");
  });

  it("omits run history when no runApi", () => {
    const ctx = baseContext({ runApi: undefined });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Run History");
  });
});

// ─── Connected providers ────────────────────────────────────

describe("buildEnrichedPrompt — provider documentation", () => {
  it("shows PROVIDER.md path when hasProviderDoc is true", () => {
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

  it("falls back to docsUrl when hasProviderDoc is false", () => {
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

  it("shows nothing when no doc and no docsUrl", () => {
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

  it("includes authenticated provider API section when connected", () => {
    const ctx = baseContext({
      tokens: { "@test/gmail": "access_token_123" },
      providers: [
        {
          id: "@test/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          authorizedUris: ["https://gmail.googleapis.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Authenticated Provider API");
    expect(prompt).toContain("$SIDECAR_URL/proxy");
    expect(prompt).toContain("X-Provider");
    expect(prompt).toContain("X-Target");
    expect(prompt).toContain("Gmail");
    expect(prompt).toContain("@test/gmail");
    // Auth line must show the correct credential placeholder
    expect(prompt).toContain("Authorization: Bearer {{access_token}}");
  });

  it("omits provider section when no connected providers", () => {
    const ctx = baseContext({
      tokens: {},
      providers: [
        {
          id: "@test/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          authorizedUris: [],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Authenticated Provider API");
  });

  it("shows authorized URLs", () => {
    const ctx = baseContext({
      tokens: { "@test/api": "tok" },
      providers: [
        {
          id: "@test/api",
          displayName: "My API",
          authMode: "api_key",
          credentialHeaderName: "X-Api-Key",
          credentialHeaderPrefix: "",
          authorizedUris: ["https://api.example.com/*", "https://api2.example.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("https://api.example.com/*");
    expect(prompt).toContain("https://api2.example.com/*");
  });

  it("shows 'all public URLs' when allowAllUris is true", () => {
    const ctx = baseContext({
      tokens: { "@test/openapi": "tok" },
      providers: [
        {
          id: "@test/openapi",
          displayName: "Open API",
          authMode: "api_key",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          allowAllUris: true,
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("all public URLs");
  });

  it("shows correct auth placeholder for api_key providers", () => {
    const ctx = baseContext({
      tokens: { "@test/stripe": "tok" },
      providers: [
        {
          id: "@test/stripe",
          displayName: "Stripe",
          authMode: "api_key",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          authorizedUris: ["https://api.stripe.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Authorization: Bearer {{api_key}}");
  });

  it("shows credential variables for credentialSchema providers", () => {
    const ctx = baseContext({
      tokens: { "@test/custom": "tok" },
      providers: [
        {
          id: "@test/custom",
          displayName: "Custom Service",
          authMode: "custom",
          credentialSchema: {
            properties: {
              api_key: { description: "API Key" },
              secret: { description: "Secret Token" },
            },
          },
          authorizedUris: ["https://custom.api.com/*"],
        },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("{{api_key}}");
    expect(prompt).toContain("{{secret}}");
    expect(prompt).toContain("API Key");
    expect(prompt).toContain("Secret Token");
  });
});

// ─── Documents/files ────────────────────────────────────────

describe("buildEnrichedPrompt — documents", () => {
  it("includes documents section when files provided", () => {
    const ctx = baseContext({
      files: [
        { fieldName: "doc", name: "report.pdf", type: "application/pdf", size: 102400 },
        { fieldName: "doc2", name: "data.csv", type: "text/csv", size: 5120 },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Documents");
    expect(prompt).toContain("report.pdf");
    expect(prompt).toContain("/workspace/documents/");
    expect(prompt).toContain("data.csv");
  });

  it("omits documents section when no files", () => {
    const ctx = baseContext({ files: [] });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Documents");
  });
});

// ─── Tools and skills ───────────────────────────────────────

describe("buildEnrichedPrompt — tools and skills", () => {
  it("includes available tools", () => {
    const ctx = baseContext({
      availableTools: [
        { id: "@org/scraper", name: "Web Scraper", description: "Scrapes web pages" },
        { id: "@org/translator", name: "Translator", description: "Translates text" },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("### Tools");
    expect(prompt).toContain("Web Scraper");
    expect(prompt).toContain("Scrapes web pages");
    expect(prompt).toContain("Translator");
  });

  it("omits tools section when no tools", () => {
    const ctx = baseContext({ availableTools: [] });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("### Tools");
  });

  it("includes available skills", () => {
    const ctx = baseContext({
      availableSkills: [
        { id: "@org/research", name: "Research", description: "Deep research capability" },
      ],
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("### Skills");
    expect(prompt).toContain("Research");
    expect(prompt).toContain(".pi/skills/");
  });

  it("omits skills section when no skills", () => {
    const ctx = baseContext({ availableSkills: [] });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("### Skills");
  });
});
