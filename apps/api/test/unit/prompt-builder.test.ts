// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildPlatformSystemPrompt } from "../../src/services/adapters/prompt-builder.ts";
import type {
  AppstrateRunPlan,
  FileReference,
  ProviderSummary,
  ToolMeta,
} from "../../src/services/adapters/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { Bundle, BundlePackage, PackageIdentity } from "@appstrate/afps-runtime/bundle";

function makeTestBundle(opts: {
  rawPrompt?: string;
  schemaVersion?: string;
  schemas?: AppstrateRunPlan["schemas"];
  timeout?: number;
  tools?: ToolMeta[];
  skills?: ToolMeta[];
  toolDocs?: Array<{ id: string; content: string }>;
}): Bundle {
  const rootManifest: Record<string, unknown> = {
    name: "@test/agent",
    version: "1.0.0",
    type: "agent",
    ...(opts.schemaVersion ? { schemaVersion: opts.schemaVersion } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.schemas?.input ? { input: { schema: opts.schemas.input } } : {}),
    ...(opts.schemas?.config ? { config: { schema: opts.schemas.config } } : {}),
    ...(opts.schemas?.output ? { output: { schema: opts.schemas.output } } : {}),
  };
  const rootFiles = new Map<string, Uint8Array>();
  rootFiles.set("manifest.json", new TextEncoder().encode(JSON.stringify(rootManifest)));
  rootFiles.set("prompt.md", new TextEncoder().encode(opts.rawPrompt ?? ""));
  const rootIdentity: PackageIdentity = "@test/agent@1.0.0";
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(rootIdentity, {
    identity: rootIdentity,
    manifest: rootManifest,
    files: rootFiles,
    integrity: "sha256-stub",
  });

  const docsById = new Map((opts.toolDocs ?? []).map((d) => [d.id, d.content]));
  for (const t of opts.tools ?? []) {
    const identity = `${t.id}@1.0.0` as PackageIdentity;
    const manifest = { name: t.name, type: "tool", description: t.description };
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const doc = docsById.get(t.id);
    if (doc) files.set("TOOL.md", new TextEncoder().encode(doc));
    packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  }
  for (const s of opts.skills ?? []) {
    const identity = `${s.id}@1.0.0` as PackageIdentity;
    const manifest = { name: s.name, type: "skill", description: s.description };
    const files = new Map<string, Uint8Array>();
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  }

  return {
    bundleFormatVersion: "1.0",
    root: rootIdentity,
    packages,
    integrity: "sha256-stub",
  };
}

/**
 * Test-local shape that mirrors the legacy `PromptContext` — tests keep
 * a flat override surface while the production signature is
 * `buildEnrichedPrompt(context, plan)`. The shim below splits it.
 */
interface PromptContext {
  rawPrompt: string;
  schemaVersion?: string;
  runId?: string;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousCheckpoint: Record<string, unknown> | null;
  runApi?: { url: string; token: string };
  input: Record<string, unknown>;
  files?: FileReference[];
  schemas: AppstrateRunPlan["schemas"];
  providers: ProviderSummary[];
  memories?: Array<{ id: number; content: string; createdAt: string | null }>;
  llmModel: string;
  llmConfig: AppstrateRunPlan["llmConfig"];
  proxyUrl?: string | null;
  timeout?: number;
  availableTools?: ToolMeta[];
  availableSkills?: ToolMeta[];
  toolDocs?: Array<{ id: string; content: string }>;
}

function splitLegacy(ctx: PromptContext): {
  context: ExecutionContext;
  plan: AppstrateRunPlan;
} {
  const context: ExecutionContext = {
    runId: ctx.runId ?? "test_run",
    input: ctx.input,
    memories: (ctx.memories ?? []).map((m) => ({
      content: m.content,
      createdAt: m.createdAt ? new Date(m.createdAt).getTime() : 0,
    })),
    ...(ctx.previousCheckpoint !== null ? { checkpoint: ctx.previousCheckpoint } : {}),
    config: ctx.config,
  };
  const bundle = makeTestBundle({
    rawPrompt: ctx.rawPrompt,
    ...(ctx.schemaVersion !== undefined ? { schemaVersion: ctx.schemaVersion } : {}),
    schemas: ctx.schemas,
    ...(ctx.timeout !== undefined ? { timeout: ctx.timeout } : {}),
    ...(ctx.availableTools ? { tools: ctx.availableTools } : {}),
    ...(ctx.availableSkills ? { skills: ctx.availableSkills } : {}),
    ...(ctx.toolDocs ? { toolDocs: ctx.toolDocs } : {}),
  });
  const plan: AppstrateRunPlan = {
    bundle,
    rawPrompt: ctx.rawPrompt,
    schemas: ctx.schemas,
    llmConfig: ctx.llmConfig,
    ...(ctx.runApi !== undefined ? { runApi: ctx.runApi } : {}),
    proxyUrl: ctx.proxyUrl,
    timeout: ctx.timeout ?? 0,
    tokens: ctx.tokens,
    providers: ctx.providers,
    availableTools: ctx.availableTools ?? [],
    availableSkills: ctx.availableSkills ?? [],
    toolDocs: ctx.toolDocs ?? [],
    files: ctx.files,
  };
  return { context, plan };
}

function buildEnrichedPrompt(ctx: PromptContext): string {
  const { context, plan } = splitLegacy(ctx);
  return buildPlatformSystemPrompt(context, plan);
}

function baseContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    rawPrompt: "Do the task.",
    tokens: {},
    config: {},
    previousCheckpoint: null,
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
      { id: "@appstrate/output", name: "Output", description: "Return run result" },
      {
        id: "@appstrate/set-checkpoint",
        name: "Set Checkpoint",
        description: "Persist checkpoint",
      },
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
        {
          id: "@appstrate/set-checkpoint",
          name: "Set Checkpoint",
          description: "Persist checkpoint",
        },
        { id: "@appstrate/add-memory", name: "Add Memory", description: "Save a memory" },
      ],
      toolDocs: [
        {
          id: "@appstrate/set-checkpoint",
          content: "## Checkpoint Persistence\n\nUse `set_checkpoint`.",
        },
        { id: "@appstrate/add-memory", content: "## Memory\n\nUse `add_memory`." },
      ],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Checkpoint Persistence");
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

describe("buildEnrichedPrompt — checkpoint", () => {
  it("includes checkpoint when set-checkpoint tool is available", () => {
    const ctx = contextWithSystemTools({
      previousCheckpoint: { cursor: "abc123", processedCount: 42 },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Checkpoint");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"cursor": "abc123"');
    expect(prompt).toContain('"processedCount": 42');
  });

  it("omits checkpoint when null", () => {
    const ctx = contextWithSystemTools({ previousCheckpoint: null });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Checkpoint");
  });

  it("includes checkpoint regardless of available tools", () => {
    const ctx = baseContext({
      previousCheckpoint: { cursor: "abc123" },
      availableTools: [],
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## Checkpoint");
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

// ─── Run history (zero-knowledge invariant) ────────────────

describe("buildEnrichedPrompt — run history is tool-wired, never in the prompt", () => {
  // Historical runs used to be documented in a `## Run History` section
  // whose curl snippet exposed `$SIDECAR_URL`. That surface was migrated
  // to a typed `run_history` tool wired by the runtime (runtime-pi
  // Phase D); the prompt MUST NEVER mention the sidecar, regardless of
  // whether `runApi` credentials are present.

  it("does not render a Run History section when runApi is present", () => {
    const ctx = baseContext({
      runApi: { url: "http://platform:3000", token: "exec_token_123" },
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Run History");
    expect(prompt).not.toContain("$SIDECAR_URL");
  });

  it("does not render a Run History section when runApi is absent", () => {
    const ctx = baseContext({ runApi: undefined });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).not.toContain("## Run History");
    expect(prompt).not.toContain("$SIDECAR_URL");
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

  it("advertises the `provider_call` MCP tool with the bare providerId per connected provider (no curl / no $SIDECAR_URL)", () => {
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
    expect(prompt).toContain("## Connected Providers");
    // Single MCP tool — `provider_call` — replaces every per-provider alias.
    expect(prompt).toContain("provider_call");
    expect(prompt).toContain("Gmail");
    expect(prompt).toContain("@test/gmail");
    // Per-provider alias names are gone — every call goes through provider_call({ providerId, … }).
    expect(prompt).not.toContain("test_gmail_call");
    // No more legacy curl / sidecar boilerplate inside the provider section.
    expect(prompt).not.toContain("## Authenticated Provider API");
    expect(prompt).not.toContain("$SIDECAR_URL/proxy");
    expect(prompt).not.toContain("X-Provider");
    expect(prompt).not.toContain("X-Target");
    expect(prompt).not.toContain("{{access_token}}");
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
    expect(prompt).not.toContain("## Connected Providers");
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

  it("does not leak credential placeholders — the provider tool injects them server-side", () => {
    // Previously the prompt enumerated `{{access_token}}` / `{{api_key}}`
    // so the agent could substitute them in a curl header. With the
    // `provider_call` MCP tool, credential injection is entirely server-side
    // and placeholders MUST not appear in the prompt.
    const ctx = baseContext({
      tokens: { "@test/stripe": "tok", "@test/custom": "tok" },
      providers: [
        {
          id: "@test/stripe",
          displayName: "Stripe",
          authMode: "api_key",
          credentialHeaderName: "Authorization",
          credentialHeaderPrefix: "Bearer ",
          authorizedUris: ["https://api.stripe.com/*"],
        },
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
    // The single canonical MCP tool name appears…
    expect(prompt).toContain("provider_call");
    // …per-provider alias names do NOT…
    expect(prompt).not.toContain("test_stripe_call");
    expect(prompt).not.toContain("test_custom_call");
    // …and credential placeholders / header hints do NOT either.
    expect(prompt).not.toContain("{{api_key}}");
    expect(prompt).not.toContain("{{secret}}");
    expect(prompt).not.toContain("Authorization: Bearer");
    expect(prompt).not.toContain("Auth:");
    expect(prompt).not.toContain("Credentials:");
    expect(prompt).not.toContain("Other credential vars");
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
    expect(prompt).toContain("./documents/");
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

// ─── schemaVersion template rendering ──────────────────────

describe("buildEnrichedPrompt — schemaVersion 1.1 template rendering", () => {
  it("does NOT interpolate {{…}} in legacy schemaVersion 1.0 (verbatim append)", () => {
    const ctx = baseContext({
      schemaVersion: "1.0",
      runId: "run_abc",
      input: { topic: "physics" },
      rawPrompt: "Topic is {{input.topic}}, run {{runId}}.",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Topic is {{input.topic}}, run {{runId}}.");
    expect(prompt).not.toContain("Topic is physics");
  });

  it("does NOT interpolate when schemaVersion is undefined (defaults to legacy)", () => {
    const ctx = baseContext({
      schemaVersion: undefined,
      runId: "r",
      input: { x: "y" },
      rawPrompt: "raw {{input.x}}",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("raw {{input.x}}");
  });

  it("renders {{runId}} and {{input.*}} on schemaVersion 1.1", () => {
    const ctx = baseContext({
      schemaVersion: "1.1",
      runId: "run_abc",
      input: { topic: "quantum" },
      rawPrompt: "Investigate {{input.topic}} for {{runId}}.",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Investigate quantum for run_abc.");
    expect(prompt).not.toContain("{{");
  });

  it("renders memory sections on schemaVersion 1.1", () => {
    const ctx = baseContext({
      schemaVersion: "1.1",
      memories: [
        { id: 1, content: "alpha", createdAt: "2026-01-01T00:00:00Z" },
        { id: 2, content: "beta", createdAt: null },
      ],
      rawPrompt: "Past:\n{{#memories}}- {{content}}\n{{/memories}}End.",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("Past:\n- alpha\n- beta\nEnd.");
  });

  it("inverted section renders when memories are empty on 1.1", () => {
    const ctx = baseContext({
      schemaVersion: "1.1",
      memories: [],
      rawPrompt: "{{^memories}}No prior memories.{{/memories}}",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("No prior memories.");
  });

  it("renders higher minor (1.2) and future majors (2.0) through the template path", () => {
    const tpl = "Hello {{input.who}}";
    const forVersion = (v: string): string =>
      buildEnrichedPrompt(
        baseContext({ schemaVersion: v, input: { who: "World" }, rawPrompt: tpl }),
      );
    expect(forVersion("1.2")).toContain("Hello World");
    expect(forVersion("2.0")).toContain("Hello World");
  });

  it("treats a malformed schemaVersion as legacy (verbatim)", () => {
    const ctx = baseContext({
      schemaVersion: "not-a-version",
      input: { x: 1 },
      rawPrompt: "{{input.x}}",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("{{input.x}}");
  });

  it("preserves the enrichment sections when schemaVersion is 1.1", () => {
    const ctx = baseContext({
      schemaVersion: "1.1",
      input: { task: "hello" },
      rawPrompt: "Run: {{input.task}}",
    });
    const prompt = buildEnrichedPrompt(ctx);
    expect(prompt).toContain("## System");
    expect(prompt).toContain("Appstrate platform");
    expect(prompt).toMatch(/Run: hello$/);
  });
});
