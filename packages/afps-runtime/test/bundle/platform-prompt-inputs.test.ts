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
  it("extracts template + schema_version + timeout from the root package", () => {
    const root = pkg(
      "@acme/agent@1.0.0",
      { type: "agent", schema_version: "2.0", timeout: 120 },
      { "prompt.md": "HELLO" },
    );
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx());
    expect(inputs.template).toBe("HELLO");
    expect(inputs.schemaVersion).toBe("2.0");
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

  it("collects skill dependencies (mcp-servers are advertised via MCP tools/list, not derived here)", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    // An `mcp-server` package must NOT surface — only skills are collected;
    // mcp-server tools reach the model via MCP `tools/list`.
    const mcp = pkg(
      "@acme/m1@1.0.0",
      {
        manifest_version: "0.3",
        name: "m1-server",
        version: "1.0.0",
        _meta: { "dev.afps/mcp-server": { name: "@acme/m1", type: "mcp-server" } },
      },
      { "server/index.js": "//" },
    );
    const skill = pkg("@acme/s1@1.0.0", { type: "skill", name: "skill-one" });
    const inputs = buildPlatformPromptInputs(bundleOf(root, mcp, skill), ctx());
    expect(inputs.availableSkills).toEqual([{ id: "@acme/s1", name: "skill-one" }]);
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

  it("produces options that renderPlatformPrompt accepts end-to-end", () => {
    const root = pkg(
      "@acme/agent@1.0.0",
      {
        type: "agent",
        schema_version: "2.0",
        timeout: 60,
        output: { schema: { properties: { msg: { type: "string" } }, required: ["msg"] } },
      },
      { "prompt.md": "Do the thing." },
    );
    const mcp = pkg("@acme/m@1.0.0", {
      manifest_version: "0.3",
      name: "m-server",
      version: "1.0.0",
      _meta: { "dev.afps/mcp-server": { name: "@acme/m", type: "mcp-server" } },
    });
    const prompt = renderPlatformPrompt(
      buildPlatformPromptInputs(bundleOf(root, mcp), ctx(), { platformName: "Test" }),
    );
    expect(prompt).toContain("running on the Test platform");
    expect(prompt).toContain("**Timeout**: You have 60 seconds");
    // mcp-server tools are advertised via MCP tools/list — not in the prompt.
    expect(prompt).not.toContain("### Tools");
    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("Do the thing.");
  });

  it("omits section-driving fields when the bundle has none", () => {
    const root = pkg("@acme/agent@1.0.0", { type: "agent" }, { "prompt.md": "" });
    const inputs = buildPlatformPromptInputs(bundleOf(root), ctx());
    expect(inputs.availableSkills).toEqual([]);
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
