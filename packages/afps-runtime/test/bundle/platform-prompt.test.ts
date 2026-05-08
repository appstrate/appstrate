// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { renderPlatformPrompt } from "../../src/bundle/platform-prompt.ts";
import type { ExecutionContext } from "../../src/types/execution-context.ts";

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "run_test",
    input: {},
    ...overrides,
  };
}

describe("renderPlatformPrompt", () => {
  it("emits a System + Environment section with the default platform name", () => {
    const out = renderPlatformPrompt({ template: "TEMPLATE", context: ctx() });
    expect(out).toContain("## System");
    expect(out).toContain("running on the Appstrate platform");
    expect(out).toContain("### Environment");
    expect(out).toContain("Ephemeral container");
  });

  it("uses the overridden platformName", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      platformName: "Acme",
    });
    expect(out).toContain("running on the Acme platform");
    expect(out).not.toContain("Appstrate");
  });

  it("surfaces the timeout line when set", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx(), timeoutSeconds: 60 });
    expect(out).toContain("**Timeout**: You have 60 seconds");
  });

  it("omits the timeout line when absent", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("**Timeout**");
  });

  it("lists tools + skills when provided", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      availableTools: [{ id: "@x/tool", name: "x-tool", description: "Do X" }],
      availableSkills: [{ id: "@x/skill", name: "x-skill" }],
    });
    expect(out).toContain("### Tools");
    expect(out).toContain("**x-tool**: Do X");
    expect(out).toContain("### Skills");
    expect(out).toContain("**x-skill**");
  });

  it("appends raw toolDocs verbatim after the Tools section", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      toolDocs: [{ id: "@x/tool", content: "## How to use x-tool\n\nBe careful." }],
    });
    expect(out).toContain("## How to use x-tool");
    expect(out).toContain("Be careful");
  });

  it("emits the Connected Providers section pointing to the provider_call MCP tool", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      providers: [
        {
          id: "@appstrate/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      ],
    });
    expect(out).toContain("## Connected Providers");
    expect(out).toContain("provider_call");
    expect(out).toContain("**Gmail** (`@appstrate/gmail`)");
    expect(out).toContain("Authorized URLs: https://gmail.googleapis.com/**");
    expect(out).toContain("provider-<scope>-<name>");
    expect(out).toContain("<available_skills>");
    expect(out).not.toContain(".pi/providers/");
    // Per-provider alias names are gone — every call goes through provider_call({ providerId, … }).
    expect(out).not.toContain("appstrate_gmail_call");
  });

  it("documents binary upload/download contract when providers are connected", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      providers: [
        {
          id: "@appstrate/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
        },
      ],
    });
    // Binary contract guidance must appear so the LLM picks fromFile / toFile
    // over base64-stuffing large payloads into tool args.
    expect(out).toContain("fromFile");
    expect(out).toContain("toFile");
    expect(out).toContain("body.kind");
  });

  it("omits the binary upload/download contract when no providers are connected", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("fromFile");
    expect(out).not.toContain("toFile");
    expect(out).not.toContain("## Connected Providers");
  });

  it("shows 'all public URLs' when allowAllUris is true", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      providers: [
        {
          id: "@x/open",
          displayName: "Open",
          authMode: "api_key",
          allowAllUris: true,
        },
      ],
    });
    expect(out).toContain("Authorized URLs: all public URLs");
  });

  it("does not surface docsUrl in the providers list (carried by the provider skill instead)", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      providers: [
        {
          id: "@x/linked",
          displayName: "Linked",
          authMode: "oauth2",
          docsUrl: "https://docs.linked.example/api",
        },
      ],
    });
    expect(out).not.toContain("Documentation: https://docs.linked.example/api");
    expect(out).not.toContain(".pi/providers/");
  });

  it("renders the User Input section with schema type/required info", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx({ input: { topic: "vans" } }),
      inputSchema: {
        properties: {
          topic: { type: "string", description: "Topic to research" },
        },
        required: ["topic"],
      },
    });
    expect(out).toContain("## User Input");
    expect(out).toContain("**topic** (string, required): Topic to research — `vans`");
  });

  it("hides file fields from User Input when the schema marks them", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx({ input: { report: "https://docs.example/r.pdf" } }),
      inputSchema: {
        properties: {
          report: { type: "string", format: "uri", contentMediaType: "application/pdf" },
        },
      },
    });
    expect(out).not.toContain("**report**");
  });

  it("renders the Documents section from uploads", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      uploads: [
        { name: "report.pdf", path: "./documents/report.pdf", size: 2048, type: "application/pdf" },
      ],
    });
    expect(out).toContain("## Documents");
    expect(out).toContain("**report.pdf** (application/pdf, 2.0 KB) → `./documents/report.pdf`");
  });

  it("mentions `./documents/` in the Workspace bullet when uploads are wired", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      uploads: [{ name: "r.pdf", path: "./documents/r.pdf", size: 100, type: "application/pdf" }],
    });
    // Workspace bullet should reference ./documents/ exactly when uploads exist
    // — paired with the `## Documents` section gated on the same condition.
    expect(out).toContain("**Workspace**");
    expect(out).toContain("./documents/");
    expect(out).toContain("`## Documents` section");
  });

  it("omits the `./documents/` mention from the Workspace bullet when no uploads are wired", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    // Workspace bullet itself must still render — only the uploads sentence is gated.
    expect(out).toContain("**Workspace**");
    expect(out).toContain("filesystem for temporary processing");
    expect(out).not.toContain("./documents/");
    expect(out).not.toContain("## Documents");
  });

  it("renders the Checkpoint section when context.checkpoint is set", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx({ checkpoint: { cursor: "abc", count: 12 } }),
    });
    expect(out).toContain("## Checkpoint");
    expect(out).not.toContain("## Previous State");
    expect(out).toContain('"cursor": "abc"');
    expect(out).toContain('"count": 12');
    expect(out).toContain('pin({ key: "checkpoint"');
  });

  describe("Pinned Slots section", () => {
    it("omits the section when pinnedSlots is undefined", () => {
      const out = renderPlatformPrompt({ template: "T", context: ctx() });
      expect(out).not.toContain("## Pinned Slots");
    });

    it("omits the section when pinnedSlots is an empty object", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ pinnedSlots: {} }),
      });
      expect(out).not.toContain("## Pinned Slots");
    });

    it("renders the section with sorted keys for deterministic output", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({
          pinnedSlots: {
            zeta: "last alphabetically",
            alpha: "first alphabetically",
            mu: "middle",
          },
        }),
      });
      expect(out).toContain("## Pinned Slots");
      const alphaIdx = out.indexOf("### alpha");
      const muIdx = out.indexOf("### mu");
      const zetaIdx = out.indexOf("### zeta");
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(muIdx).toBeGreaterThan(alphaIdx);
      expect(zetaIdx).toBeGreaterThan(muIdx);
    });

    it("renders string values plain (no JSON fence)", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ pinnedSlots: { persona: "You are a helpful assistant." } }),
      });
      expect(out).toContain("### persona");
      expect(out).toContain("You are a helpful assistant.");
      // The string slot itself must not be wrapped in a json fence.
      const slotIdx = out.indexOf("### persona");
      const slotEnd = out.indexOf("###", slotIdx + 1);
      const slotBlock = out.slice(slotIdx, slotEnd > -1 ? slotEnd : undefined);
      expect(slotBlock).not.toContain("```json");
    });

    it("renders structured values inside a fenced JSON block", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({
          pinnedSlots: {
            goals: { primary: "ship", secondary: ["test", "doc"] },
          },
        }),
      });
      expect(out).toContain("### goals");
      expect(out).toContain("```json");
      expect(out).toContain('"primary": "ship"');
      expect(out).toContain('"secondary"');
    });

    it("includes a footer telling the agent how to update slots and where checkpoint goes", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ pinnedSlots: { persona: "anything" } }),
      });
      expect(out).toContain('pin({ key: "<your-key>"');
      // Must redirect agents to the dedicated checkpoint key for carry-over,
      // so the two surfaces don't get conflated.
      expect(out).toContain('key: "checkpoint"');
    });

    it("renders after the Checkpoint section when both are present", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({
          checkpoint: { cursor: "x" },
          pinnedSlots: { persona: "you are X" },
        }),
      });
      const checkpointIdx = out.indexOf("## Checkpoint");
      const pinnedIdx = out.indexOf("## Pinned Slots");
      expect(checkpointIdx).toBeGreaterThan(-1);
      expect(pinnedIdx).toBeGreaterThan(checkpointIdx);
    });
  });

  it("renders the Memory section with pinned memories listed", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx({
        memories: [
          { content: "fact one", createdAt: 1_700_000_000_000 },
          { content: "fact two", createdAt: 1_700_000_100_000 },
        ],
      }),
    });
    expect(out).toContain("## Memory");
    expect(out).toContain("Pinned memories");
    expect(out).toContain("- fact one");
    expect(out).toContain("- fact two");
    expect(out).toContain("note({ content })");
    expect(out).toContain("recall_memory");
    expect(out).toContain("pin({ key, content })");
    // Memory section should mention scope-default behaviour.
    expect(out).toMatch(/scope.*"shared"/);
  });

  it("always emits the Memory section (with archive hint) even when nothing is pinned", () => {
    // Per ADR-012 the agent always needs to know `recall_memory` exists,
    // including when no memory is pinned to the prompt yet — otherwise
    // the LLM has no way to discover it should search the archive.
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).toContain("## Memory");
    expect(out).toContain("No memories are currently pinned");
    expect(out).toContain("recall_memory");
  });

  it("never emits sidecar-knowledge sections — run history is surfaced via a typed tool", () => {
    // Before the run_history tool migration, a `## Run History` section
    // with a `curl $SIDECAR_URL/run-history` snippet was emitted when
    // `runHistoryApi: true` was passed in. That surface is gone: the
    // prompt must never mention $SIDECAR_URL, regardless of the options
    // bag. Run history is wired via the `run_history` tool whose
    // description is surfaced through `availableTools` instead.
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("## Run History");
    expect(out).not.toContain("$SIDECAR_URL");
  });

  it("surfaces run_history in the Tools section when present in availableTools", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      availableTools: [
        { id: "run_history", name: "run_history", description: "Fetch prior run metadata." },
      ],
    });
    expect(out).toContain("### Tools");
    expect(out).toContain("run_history");
    expect(out).toContain("Fetch prior run metadata.");
    expect(out).not.toContain("$SIDECAR_URL");
  });

  it("appends raw template verbatim for pre-1.1 schemaVersion", () => {
    const out = renderPlatformPrompt({
      template: "Template with {{runId}} reference",
      context: ctx(),
      schemaVersion: "1.0.0",
    });
    expect(out).toContain("Template with {{runId}} reference");
  });

  it("renders the template via Mustache for 1.1+ schemaVersion", () => {
    const out = renderPlatformPrompt({
      template: "Hi {{runId}}",
      context: ctx({ runId: "run_abc" }),
      schemaVersion: "1.1.0",
    });
    expect(out).toContain("Hi run_abc");
    expect(out).not.toContain("{{runId}}");
  });

  it("preserves ---\\n\\n separator between preamble and template", () => {
    const out = renderPlatformPrompt({
      template: "USER_TEMPLATE_BODY",
      context: ctx(),
    });
    expect(out).toContain("\n---\n\nUSER_TEMPLATE_BODY");
  });

  describe("Output Format section", () => {
    const schema = {
      type: "object",
      required: ["random"],
      properties: {
        random: { type: "number", description: "A random float between 0 and 1" },
      },
    };

    it("emits the section when outputSchema is provided", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: schema,
      });
      expect(out).toContain("## Output Format");
      expect(out).toContain("exactly once");
      expect(out).toContain("do not probe");
    });

    it("omits the section when outputSchema is absent or empty", () => {
      const without = renderPlatformPrompt({ template: "T", context: ctx() });
      expect(without).not.toContain("## Output Format");
      const withEmpty = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: {},
      });
      expect(withEmpty).not.toContain("## Output Format");
    });

    it("lists each property with type, required flag, and description", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: schema,
      });
      expect(out).toContain("### Required shape");
      expect(out).toContain("- **random** (number, required): A random float between 0 and 1");
    });

    it("marks optional fields as optional", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: {
          type: "object",
          required: ["a"],
          properties: { a: { type: "string" }, b: { type: "number" } },
        },
      });
      expect(out).toContain("- **a** (string, required)");
      expect(out).toContain("- **b** (number, optional)");
    });

    it("includes the full JSON Schema block", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: schema,
      });
      expect(out).toContain("### Full JSON Schema");
      expect(out).toContain('"required": [\n    "random"\n  ]');
      expect(out).toContain('"type": "number"');
    });

    it("renders before the template separator so the constraint precedes the task prompt", () => {
      const out = renderPlatformPrompt({
        template: "USER_TEMPLATE_BODY",
        context: ctx(),
        outputSchema: schema,
      });
      const outputIdx = out.indexOf("## Output Format");
      const sepIdx = out.indexOf("\n---\n\nUSER_TEMPLATE_BODY");
      expect(outputIdx).toBeGreaterThan(-1);
      expect(sepIdx).toBeGreaterThan(outputIdx);
    });

    it("tolerates schemas without `properties` (list section skipped, full schema still shown)", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: { type: "string" },
      });
      expect(out).toContain("## Output Format");
      expect(out).not.toContain("### Required shape");
      expect(out).toContain("### Full JSON Schema");
    });
  });
});
