// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildPlatformPromptInputs } from "../../src/bundle/platform-prompt-inputs.ts";
import { renderPlatformPrompt } from "../../src/bundle/platform-prompt.ts";
import type { Bundle, BundlePackage, PackageIdentity } from "../../src/bundle/types.ts";
import type { ExecutionContext } from "../../src/types/execution-context.ts";

function pkg(
  identity: PackageIdentity,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): BundlePackage {
  const fileMap = new Map<string, Uint8Array>();
  fileMap.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  for (const [path, content] of Object.entries(files)) {
    fileMap.set(path, new TextEncoder().encode(content));
  }
  return { identity, manifest, files: fileMap, integrity: "sha256-stub" };
}

function bundleOf(root: BundlePackage, ...deps: BundlePackage[]): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  return {
    bundleFormatVersion: "1.0",
    root: root.identity,
    packages,
    integrity: "sha256-stub",
  };
}

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { runId: "run_test", input: {}, ...overrides };
}

describe("buildPlatformPromptInputs", () => {
  it("extracts template + schemaVersion + timeout from the root package", () => {
    const root = pkg(
      "@acme/agent@1.0.0",
      { type: "agent", schemaVersion: "1.3", timeout: 120 },
      { "prompt.md": "HELLO" },
    );
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx());
    expect(inputs.template).toBe("HELLO");
    expect(inputs.schemaVersion).toBe("1.3");
    expect(inputs.timeoutSeconds).toBe(120);
  });

  it("derives input / config / output schemas from the root manifest wrappers", () => {
    const root = pkg(
      "@acme/agent@1.0.0",
      {
        type: "agent",
        input: { schema: { properties: { q: { type: "string" } }, required: ["q"] } },
        config: { schema: { properties: { verbose: { type: "boolean" } } } },
        output: { schema: { properties: { result: { type: "string" } }, required: ["result"] } },
      },
      { "prompt.md": "T" },
    );
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx());
    expect(inputs.inputSchema?.properties).toEqual({ q: { type: "string" } });
    expect(inputs.inputSchema?.required).toEqual(["q"]);
    expect(inputs.configSchema?.properties).toEqual({ verbose: { type: "boolean" } });
    expect(inputs.outputSchema).toEqual({
      properties: { result: { type: "string" } },
      required: ["result"],
    });
  });

  it("classifies dependencies by manifest.type (tool / skill / provider)", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const tool = pkg(
      "@acme/t1@1.0.0",
      { type: "tool", name: "tool-one", description: "First" },
      { "TOOL.md": "# tool-one docs" },
    );
    const skill = pkg("@acme/s1@1.0.0", { type: "skill", name: "skill-one" });
    const provider = pkg("@acme/p1@1.0.0", {
      type: "provider",
      name: "Gmail",
      definition: {
        authMode: "oauth2",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        docsUrl: "https://developers.google.com/gmail/api",
      },
    });
    const inputs = buildPlatformPromptInputs(bundleOf(root, tool, skill, provider), ctx());
    expect(inputs.availableTools).toEqual([
      { id: "@acme/t1", name: "tool-one", description: "First" },
    ]);
    expect(inputs.availableSkills).toEqual([{ id: "@acme/s1", name: "skill-one" }]);
    expect(inputs.toolDocs).toEqual([{ id: "@acme/t1", content: "# tool-one docs" }]);
    expect(inputs.providers).toEqual([
      {
        id: "@acme/p1",
        displayName: "Gmail",
        authMode: "oauth2",
        docsUrl: "https://developers.google.com/gmail/api",
        authorizedUris: ["https://gmail.googleapis.com/**"],
      },
    ]);
  });

  it("prefers manifest.tool.name over manifest.name as the LLM-facing tool identifier", () => {
    // AFPS 1.5+ tool packages declare the LLM-facing tool name under
    // `manifest.tool.name` (e.g. @appstrate/pin → "pin"). The package's
    // `name` is the display identifier. The runtime gating in
    // `renderPlatformPrompt` (#368) keys off `availableTools[i].name`,
    // so the LLM-facing name MUST win when both are present — otherwise
    // gates like `t.name === "pin"` would never match real bundles.
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const pinTool = pkg("@appstrate/pin@1.0.0", {
      name: "@appstrate/pin",
      type: "tool",
      description: "Upsert a pinned slot",
      tool: { name: "pin" },
    });
    const inputs = buildPlatformPromptInputs(bundleOf(root, pinTool), ctx());
    expect(inputs.availableTools).toEqual([
      { id: "@appstrate/pin", name: "pin", description: "Upsert a pinned slot" },
    ]);
  });

  it("falls back to manifest.name when manifest.tool.name is absent (legacy/non-tool-block packages)", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const legacy = pkg("@acme/legacy@1.0.0", {
      name: "legacy-tool",
      type: "tool",
      description: "Legacy",
    });
    const inputs = buildPlatformPromptInputs(bundleOf(root, legacy), ctx());
    expect(inputs.availableTools).toEqual([
      { id: "@acme/legacy", name: "legacy-tool", description: "Legacy" },
    ]);
  });

  it("applies scalar overrides verbatim (platformName, timeoutSeconds)", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent", timeout: 120 }, { "prompt.md": "T" });
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx(), {
      platformName: "Custom",
      timeoutSeconds: 300,
    });
    expect(inputs.platformName).toBe("Custom");
    expect(inputs.timeoutSeconds).toBe(300);
  });

  it("merges provider overrides by id (override fields win, bundle fields fill gaps)", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const provider = pkg("@acme/p1@1.0.0", {
      type: "provider",
      name: "Gmail",
      definition: { authMode: "oauth2", authorizedUris: ["https://old.example.com/**"] },
    });
    const inputs = buildPlatformPromptInputs(bundleOf(root, provider), ctx(), {
      providers: [
        {
          id: "@acme/p1",
          authorizedUris: ["https://gmail.googleapis.com/**", "https://oauth2.googleapis.com/**"],
        },
      ],
    });
    expect(inputs.providers).toEqual([
      {
        id: "@acme/p1",
        displayName: "Gmail",
        authMode: "oauth2",
        authorizedUris: ["https://gmail.googleapis.com/**", "https://oauth2.googleapis.com/**"],
      },
    ]);
  });

  it("providersReplace: true swaps bundle-derived providers for the override list", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const gmail = pkg("@acme/gmail@1.0.0", { type: "provider", name: "Gmail" });
    const slack = pkg("@acme/slack@1.0.0", { type: "provider", name: "Slack" });
    const inputs = buildPlatformPromptInputs(bundleOf(root, gmail, slack), ctx(), {
      providers: [
        { id: "@acme/gmail", displayName: "Gmail", authorizedUris: ["https://g.example/**"] },
      ],
      providersReplace: true,
    });
    expect(inputs.providers).toEqual([
      { id: "@acme/gmail", displayName: "Gmail", authorizedUris: ["https://g.example/**"] },
    ]);
  });

  it("appends override-only providers after bundle-derived ones", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const provider = pkg("@acme/p1@1.0.0", { type: "provider", name: "Gmail" });
    const inputs = buildPlatformPromptInputs(bundleOf(root, provider), ctx(), {
      providers: [{ id: "@acme/extra", displayName: "Extra", allowAllUris: true }],
    });
    expect(inputs.providers?.map((p) => p.id)).toEqual(["@acme/p1", "@acme/extra"]);
  });

  it("produces options that renderPlatformPrompt accepts end-to-end", () => {
    const root = pkg(
      "@acme/agent@1.0.0",
      {
        type: "agent",
        schemaVersion: "1.3",
        timeout: 60,
        output: { schema: { properties: { msg: { type: "string" } }, required: ["msg"] } },
      },
      { "prompt.md": "Do the thing." },
    );
    const tool = pkg("@acme/t@1.0.0", { type: "tool", name: "t", description: "d" });
    const prompt = renderPlatformPrompt(
      buildPlatformPromptInputs(bundleOf(root, tool), ctx(), { platformName: "Test" }),
    );
    expect(prompt).toContain("running on the Test platform");
    expect(prompt).toContain("**Timeout**: You have 60 seconds");
    expect(prompt).toContain("### Tools");
    expect(prompt).toContain("**t**: d");
    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("Do the thing.");
  });

  it("omits section-driving fields when the bundle has none", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx());
    expect(inputs.availableTools).toEqual([]);
    expect(inputs.availableSkills).toEqual([]);
    expect(inputs.providers).toEqual([]);
    expect(inputs.toolDocs).toEqual([]);
    expect(inputs.inputSchema).toBeUndefined();
    expect(inputs.outputSchema).toBeUndefined();
  });

  it("overrides never leak context — caller-supplied context always wins", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const myCtx = ctx({ checkpoint: { a: 1 } });
    const inputs = buildPlatformPromptInputs(bundleOf(root), myCtx);
    expect(inputs.context).toBe(myCtx);
  });
});
