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

// ─── Core structure ─────────────────────────────────────────

describe("buildEnrichedPrompt — core structure", () => {
  it("includes system identity section", () => {
    const prompt = buildEnrichedPrompt(baseContext());
    expect(prompt).toContain("## System");
    expect(prompt).toContain("Appstrate platform");
    expect(prompt).toContain("ephemeral container");
  });

  it("includes persistence section", () => {
    const prompt = buildEnrichedPrompt(baseContext());
    expect(prompt).toContain("### Persistence");
    expect(prompt).toContain("set_state");
    expect(prompt).toContain("add_memory");
  });

  it("includes output section", () => {
    const prompt = buildEnrichedPrompt(baseContext());
    expect(prompt).toContain("## Output");
    expect(prompt).toContain("report(content)");
    expect(prompt).toContain("set_state(state)");
    expect(prompt).toContain("add_memory(content)");
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
            document: { type: "file" },
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
  it("includes previous state as JSON block", () => {
    const ctx = baseContext({
      previousState: { cursor: "abc123", processedCount: 42 },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Previous State");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"cursor": "abc123"');
    expect(prompt).toContain('"processedCount": 42');
  });

  it("omits previous state when null", () => {
    const ctx = baseContext({ previousState: null });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Previous State");
  });
});

// ─── Memories ───────────────────────────────────────────────

describe("buildEnrichedPrompt — memories", () => {
  it("includes memories section", () => {
    const ctx = baseContext({
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
    const ctx = baseContext({ memories: [] });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Memory");
  });
});

// ─── Execution history API ──────────────────────────────────

describe("buildEnrichedPrompt — execution history", () => {
  it("includes execution history API when executionApi provided", () => {
    const ctx = baseContext({
      executionApi: { url: "http://platform:3000", token: "exec_token_123" },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Execution History");
    expect(prompt).toContain("$SIDECAR_URL/execution-history");
  });

  it("omits execution history when no executionApi", () => {
    const ctx = baseContext({ executionApi: undefined });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Execution History");
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

// ─── Output schema ──────────────────────────────────────────

describe("buildEnrichedPrompt — output schema", () => {
  it("includes structured_output instructions when output schema has properties", () => {
    const ctx = baseContext({
      schemas: {
        output: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Brief summary" },
            count: { type: "number", description: "Total items processed" },
          },
          required: ["summary"],
        },
      },
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("### structured_output(data)");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("Brief summary");
    expect(prompt).toContain("required");
    expect(prompt).toContain("count");
  });

  it("omits structured_output when no output schema properties", () => {
    const ctx = baseContext({
      schemas: { output: undefined },
    });

    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("### structured_output(data)");
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

// ─── User communication ────────────────────────────────────

describe("buildEnrichedPrompt — user communication", () => {
  it("includes log section when logs enabled (default)", () => {
    const ctx = baseContext();
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## User Communication");
    expect(prompt).toContain("`log` tool");
  });

  it("omits log section when logs disabled", () => {
    const ctx = baseContext({ logsEnabled: false });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## User Communication");
  });
});
