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

  it("emits the Connected Providers section with tool mapping", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx(),
      providers: [
        {
          id: "@appstrate/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/*"],
          hasProviderDoc: true,
        },
      ],
    });
    expect(out).toContain("## Connected Providers");
    expect(out).toContain("**Gmail** (`@appstrate/gmail`)");
    expect(out).toContain("appstrate_gmail_call");
    expect(out).toContain("Authorized URLs: https://gmail.googleapis.com/*");
    expect(out).toContain(".pi/providers/@appstrate/gmail/PROVIDER.md");
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

  it("uses docsUrl when hasProviderDoc is false", () => {
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
    expect(out).toContain("Documentation: https://docs.linked.example/api");
    expect(out).not.toContain(".pi/providers/@x/linked/PROVIDER.md");
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

  it("renders the Previous State section when context.state is set", () => {
    const out = renderPlatformPrompt({
      template: "T",
      context: ctx({ state: { cursor: "abc", count: 12 } }),
    });
    expect(out).toContain("## Previous State");
    expect(out).toContain('"cursor": "abc"');
    expect(out).toContain('"count": 12');
    expect(out).toContain("`set_state` tool");
  });

  it("renders the Memory section with stored memories", () => {
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
    expect(out).toContain("- fact one");
    expect(out).toContain("- fact two");
    expect(out).toContain("`add_memory` tool");
  });

  it("emits the Run History section only when runHistoryApi is true", () => {
    const off = renderPlatformPrompt({ template: "T", context: ctx() });
    expect(off).not.toContain("## Run History");

    const on = renderPlatformPrompt({ template: "T", context: ctx(), runHistoryApi: true });
    expect(on).toContain("## Run History");
    expect(on).toContain("$SIDECAR_URL/run-history");
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
});
