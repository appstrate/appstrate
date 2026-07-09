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

  it("advertises the pre-installed Python data libraries (#628)", () => {
    // Must stay in sync with the venv install line in runtime-pi/Dockerfile.
    const out = renderPlatformPrompt({ template: "TEMPLATE", context: ctx() });
    expect(out).toContain("`openpyxl`, `pandas`, `requests`, `PyPDF2`");
    expect(out).toContain("no `pip install` needed");
  });

  it("emits a Communication section forbidding free-text replies to the user", () => {
    const out = renderPlatformPrompt({ template: "TEMPLATE", context: ctx() });
    expect(out).toContain("### Communication");
    expect(out).toContain("never delivered to the user");
    expect(out).toContain("The only way to communicate with the user is by calling a tool.");
  });

  it("renders the Communication section and no Tools section (tools come from tools/list)", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out.indexOf("### Communication")).toBeGreaterThan(-1);
    expect(out).not.toContain("### Tools");
  });

  it("keeps the Communication section tool-agnostic (no opt-in tool names)", () => {
    // Per the #368 contract, platform-owned section prose must not hardcode
    // a specific tool's usage — that belongs on each tool's MCP descriptor
    // `description` (surfaced via `tools/list`).
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    const start = out.indexOf("### Communication");
    const end = out.indexOf("### Tools", start);
    const slice = out.slice(start, end > -1 ? end : out.indexOf("\n---\n", start));
    expect(slice).not.toContain("output(");
    expect(slice).not.toContain("log(");
    expect(slice).not.toContain("note(");
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

  it("lists skills (tools come from MCP tools/list, never the prompt)", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      availableSkills: [{ id: "@x/skill", name: "x-skill" }],
    });
    expect(out).not.toContain("### Tools");
    expect(out).toContain("### Skills");
    expect(out).toContain("**x-skill**");
  });

  it("omits the API Documentation subsection when an integration has no INTEGRATION.md", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      integrations: [
        {
          id: "@org/github-mcp",
          description: "GitHub integration",
        },
      ],
    });
    expect(out).toContain("## Integration: @org/github-mcp");
    expect(out).toContain("GitHub integration");
    expect(out).not.toContain("### API Documentation");
  });

  it("inlines INTEGRATION.md content under an API Documentation subsection when present", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      integrations: [
        {
          id: "@org/github-mcp",
          description: "GitHub integration",
          doc: "## GitHub API\n\nCall `list_issues` to fetch issues.",
        },
      ],
    });
    expect(out).toContain("## Integration: @org/github-mcp");
    expect(out).toContain("### API Documentation");
    expect(out).toContain("## GitHub API");
    expect(out).toContain("Call `list_issues` to fetch issues.");
  });

  it("treats whitespace-only INTEGRATION.md as absent (no API Documentation subsection)", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      integrations: [{ id: "@org/github-mcp", doc: "   \n\n  " }],
    });
    expect(out).toContain("## Integration: @org/github-mcp");
    expect(out).not.toContain("### API Documentation");
  });

  it("omits every integration section when none are passed in", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("## Integration:");
    expect(out).not.toContain("### API Documentation");
  });

  it("never emits a Connected Providers section or provider_call instructions", () => {
    // Outbound API access is surfaced via integration MCP tools
    // (`{ns}__api_call`), self-documented through MCP tools/list — never
    // through the prompt. The provider prompt dimension is fully removed.
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("## Connected Providers");
    expect(out).not.toContain("provider_call");
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

  describe("Checkpoint section", () => {
    it("renders the data block when context.checkpoint is set", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ checkpoint: { cursor: "abc", count: 12 } }),
      });
      expect(out).toContain("## Checkpoint");
      expect(out).not.toContain("## Previous State");
      expect(out).toContain('"cursor": "abc"');
      expect(out).toContain('"count": 12');
      // Data-shell prose: present (resume guidance is generic).
      expect(out).toContain("resume work");
    });

    it("does NOT mention specific tool names — usage prose lives on the MCP descriptor (#368)", () => {
      // Post-#368 contract: the platform owns the data shell, tools own
      // their usage prose. The Checkpoint section must not name any
      // tool — instructions for updating the checkpoint flow in via the
      // `pin` tool's MCP descriptor `description` (surfaced through
      // `tools/list`) when that tool is loaded.
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ checkpoint: { cursor: "abc" } }),
      });
      const sectionStart = out.indexOf("## Checkpoint");
      const sectionEnd = out.indexOf("\n## ", sectionStart + 1);
      const slice = out.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);
      expect(slice).not.toContain("pin(");
      expect(slice).not.toContain("read-only carry-over");
    });

    it("omits the section entirely when context.checkpoint is null/undefined", () => {
      const out = renderPlatformPrompt({ template: "T", context: ctx() });
      expect(out).not.toContain("## Checkpoint");
    });
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

    it("does NOT mention specific tool names — usage prose lives on the MCP descriptor (#368)", () => {
      // Post-#368 contract: data block only. The `pin` instructions
      // for updating slots come from the `pin` tool's MCP descriptor
      // `description` (surfaced via `tools/list`) when that tool is in
      // the bundle's dependency tree.
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ pinnedSlots: { persona: "anything" } }),
      });
      const sectionStart = out.indexOf("## Pinned Slots");
      const sectionEnd = out.indexOf("\n## ", sectionStart + 1);
      const slice = out.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);
      expect(slice).not.toContain("pin(");
      expect(slice).not.toContain("read-only in this build");
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

  describe("Memory section (#368)", () => {
    it("renders the data block with pinned memories listed", () => {
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
    });

    it("omits the section entirely when there are no memories", () => {
      // Post-#368: the platform prompt is data-driven. With no memories
      // and no fallback prose, the `## Memory` header is suppressed —
      // the LLM still discovers the archive via the runtime-injected
      // `recall_memory` tool docs (surfaced in `### Tools` + toolDocs).
      const out = renderPlatformPrompt({ template: "T", context: ctx() });
      expect(out).not.toContain("## Memory");
      expect(out).not.toContain("No memories are currently pinned");
    });

    it("does NOT mention specific tool names — archive APIs live on the MCP descriptor", () => {
      // Post-#368 contract: data block only. Instructions for `note`,
      // `recall_memory`, `pin` come from each tool's MCP descriptor
      // `description` (surfaced via `tools/list`) when the tool is wired.
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({
          memories: [{ content: "fact", createdAt: 1_700_000_000_000 }],
        }),
      });
      const sectionStart = out.indexOf("## Memory");
      const sectionEnd = out.indexOf("\n## ", sectionStart + 1);
      const slice = out.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);
      expect(slice).not.toContain("note({ content })");
      expect(slice).not.toContain("recall_memory({");
      expect(slice).not.toContain("pin({ key");
    });

    it("renders memories regardless of which tools are wired — data is data", () => {
      // The v1→v2 dep-removal scenario: agent v1 shipped the `note` tool
      // and accumulated memories; v2 dropped the dep. The platform
      // still surfaces the carry-over memory list (it's informative
      // context); the absence of the `note` tool from `tools/list` is
      // what tells the LLM it cannot write new ones.
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({
          memories: [{ content: "carry-over fact", createdAt: 1_700_000_000_000 }],
        }),
      });
      expect(out).toContain("## Memory");
      expect(out).toContain("- carry-over fact");
    });

    it("does not inject recall_memory docs into the prompt (the LLM learns it from tools/list)", () => {
      // The archive API is documented on the `recall_memory` MCP tool's
      // own description (surfaced via tools/list), never re-rendered in
      // the prompt.
      const recallDoc =
        "## recall_memory\n\nUse `recall_memory({ q?, limit? })` to search the archive.";
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx({ memories: [{ content: "x", createdAt: 1 }] }),
      });
      expect(out).not.toContain(recallDoc);
      expect(out).not.toContain("recall_memory");
    });
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

  it("does not surface run_history in a Tools section (it's a typed MCP tool)", () => {
    const out = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(out).not.toContain("### Tools");
    expect(out).not.toContain("run_history");
    expect(out).not.toContain("$SIDECAR_URL");
  });

  it("appends raw template verbatim", () => {
    const out = renderPlatformPrompt({
      template: "Template with {{runId}} reference",
      context: ctx(),
    });
    expect(out).toContain("Template with {{runId}} reference");
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

    it("renders the terminal `output` tool mandate (single Pi-engine channel)", () => {
      const out = renderPlatformPrompt({
        template: "T",
        context: ctx(),
        outputSchema: schema,
      });
      expect(out).toContain("call the `output` tool");
      expect(out).toContain("exactly once");
      expect(out).not.toContain("StructuredOutput");
      // Schema surfaces are always shown.
      expect(out).toContain("### Required shape");
      expect(out).toContain("### Full JSON Schema");
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
