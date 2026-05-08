// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Cross-path parity: the platform container, `appstrate run`, and any
 * external runner that re-uses `buildPlatformPromptInputs` all
 * converge on `renderPlatformPrompt(buildPlatformPromptInputs(bundle,
 * context, overrides))`. For the SAME bundle + context, the resulting
 * prompt must match across paths modulo a short, well-defined set of
 * platform-specific fields.
 *
 * Platform-specific divergences (by design):
 *   - `platformName`: "Appstrate" / "Appstrate CLI" / caller-defined
 *   - `## Documents` section: only the platform has DB-backed uploads
 *   - `## Connected Providers`: platform may filter by credential
 *     availability (providersReplace); CLI takes the bundle list as-is
 *
 * Anything else that diverges is a regression. A new contributor who
 * adds a section to `renderPlatformPrompt` without threading it through
 * `buildPlatformPromptInputs` will trip this test.
 */

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
  for (const [p, c] of Object.entries(files)) {
    fileMap.set(p, new TextEncoder().encode(c));
  }
  return { identity, manifest, files: fileMap, integrity: "sha256-stub" };
}

function makeFixtureBundle(): Bundle {
  const root = pkg(
    "@fixture/agent@1.0.0",
    {
      name: "@fixture/agent",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.3",
      timeout: 120,
      input: {
        schema: {
          properties: { query: { type: "string", description: "The question" } },
          required: ["query"],
        },
      },
      config: {
        schema: {
          properties: { verbose: { type: "boolean" } },
        },
      },
      output: {
        schema: {
          properties: { answer: { type: "string", description: "The result" } },
          required: ["answer"],
        },
      },
    },
    { "prompt.md": "Answer the user's question." },
  );
  const tool = pkg(
    "@fixture/search@1.0.0",
    { name: "search", type: "tool", description: "Search the web" },
    { "TOOL.md": "# search\nUse it wisely." },
  );
  const skill = pkg("@fixture/writing@1.0.0", {
    name: "writing",
    type: "skill",
    description: "Write clear prose",
  });
  const provider = pkg("@fixture/gmail@1.0.0", {
    name: "Gmail",
    type: "provider",
    definition: {
      authMode: "oauth2",
      authorizedUris: ["https://gmail.googleapis.com/**"],
      docsUrl: "https://developers.google.com/gmail/api",
    },
  });

  const packages = new Map<PackageIdentity, BundlePackage>();
  for (const p of [root, tool, skill, provider]) packages.set(p.identity, p);
  return {
    bundleFormatVersion: "1.0",
    root: root.identity,
    packages,
    integrity: "sha256-stub",
  };
}

function makeContext(): ExecutionContext {
  return {
    runId: "run_parity",
    input: { query: "what is the answer" },
    config: { verbose: true },
    memories: [{ content: "Last run found something useful.", createdAt: 0 }],
    checkpoint: { turn: 3 },
  };
}

/**
 * Canonicalize a rendered prompt by stripping path-specific lines and
 * sections so the cross-path residue can be compared.
 */
function canonicalize(prompt: string): string {
  return (
    prompt
      // normalize the platform identity line
      .replace(/running on the [^\n]* platform\./g, "running on the <PLATFORM> platform.")
      // strip the `## Documents` section (platform-only, DB-backed)
      .replace(/## Documents\n[\s\S]*?(?=\n## |\n---|$)/g, "")
      // strip the uploads-related sentence in the Workspace bullet
      // (platform-only when uploads are wired; CLI paths omit it)
      .replace(
        /Uploaded documents are available under `\.\/documents\/` \(relative to cwd\) and listed in the `## Documents` section below\. /g,
        "",
      )
      // strip the `## Connected Providers` section (may be filtered on
      // the platform by credential availability; CLI paths list all)
      .replace(/## Connected Providers\n[\s\S]*?(?=\n## |\n---|$)/g, "")
      // collapse repeated blank lines left by section removal
      .replace(/\n{3,}/g, "\n\n")
  );
}

describe("cross-path prompt parity", () => {
  const bundle = makeFixtureBundle();
  const context = makeContext();

  const platformPrompt = renderPlatformPrompt(
    buildPlatformPromptInputs(bundle, context, {
      platformName: "Appstrate",
      // Platform-specific: DB-backed uploads. Run history used to be
      // rendered as a `## Run History` section here; it is now surfaced
      // via the runtime-wired `run_history` tool instead so the prompt
      // never mentions the sidecar URL.
      uploads: [
        { name: "brief.pdf", path: "./documents/brief.pdf", size: 12345, type: "application/pdf" },
      ],
      // Platform-specific: filtered provider list (e.g. only those with
      // credentials wired). Replaces the bundle-derived list.
      providers: [
        {
          id: "@fixture/gmail",
          displayName: "Gmail",
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          docsUrl: "https://developers.google.com/gmail/api",
        },
      ],
      providersReplace: true,
    }),
  );

  const externalRunPrompt = renderPlatformPrompt(
    buildPlatformPromptInputs(bundle, context, { platformName: "External Runner" }),
  );

  const appstrateRunPrompt = renderPlatformPrompt(
    buildPlatformPromptInputs(bundle, context, { platformName: "Appstrate CLI" }),
  );

  it("all three paths render every bundle-derived section", () => {
    for (const prompt of [platformPrompt, externalRunPrompt, appstrateRunPrompt]) {
      expect(prompt).toContain("## System");
      expect(prompt).toContain("### Environment");
      expect(prompt).toContain("### Tools");
      expect(prompt).toContain("**search**: Search the web");
      expect(prompt).toContain("### Skills");
      expect(prompt).toContain("**writing**: Write clear prose");
      expect(prompt).toContain("## User Input");
      expect(prompt).toContain("**query**");
      expect(prompt).toContain("## Configuration");
      expect(prompt).toContain("## Checkpoint");
      expect(prompt).toContain("## Memory");
      expect(prompt).toContain("## Output Format");
      expect(prompt).toContain("Answer the user's question.");
      expect(prompt).toContain("**Timeout**: You have 120 seconds");
    }
  });

  it("OUTPUT_SCHEMA propagation is consistent across paths", () => {
    // All three prompts surface the full output schema in the tail
    // `## Output Format` section — the belt-and-suspenders against
    // weaker models that ignore tool-level required fields.
    for (const prompt of [platformPrompt, externalRunPrompt, appstrateRunPrompt]) {
      expect(prompt).toContain('"answer"');
      expect(prompt).toContain('"required"');
    }
  });

  it("external and appstrate CLI paths produce IDENTICAL prompts modulo platformName", () => {
    expect(canonicalize(externalRunPrompt)).toEqual(canonicalize(appstrateRunPrompt));
  });

  it("platform prompt matches CLI prompts modulo the documented divergences", () => {
    // Platform: includes Documents and filtered Connected Providers.
    // Canonicalize strips these platform-only sections so the residue
    // must match the CLI render byte-for-byte.
    expect(canonicalize(platformPrompt)).toEqual(canonicalize(externalRunPrompt));
  });

  it("only the CLI paths list providers from the bundle as-is", () => {
    expect(externalRunPrompt).toContain("## Connected Providers");
    expect(externalRunPrompt).toContain("**Gmail**");
    expect(appstrateRunPrompt).toContain("## Connected Providers");
    expect(appstrateRunPrompt).toContain("**Gmail**");
    // Platform path also has it, just potentially filtered
    expect(platformPrompt).toContain("## Connected Providers");
  });

  it("only the platform path emits the Documents section", () => {
    expect(platformPrompt).toContain("## Documents");
    expect(platformPrompt).toContain("**brief.pdf**");
    expect(externalRunPrompt).not.toContain("## Documents");
    expect(appstrateRunPrompt).not.toContain("## Documents");
  });

  it("no prompt path mentions the sidecar URL (zero-knowledge invariant)", () => {
    for (const prompt of [platformPrompt, externalRunPrompt, appstrateRunPrompt]) {
      expect(prompt).not.toContain("$SIDECAR_URL");
      expect(prompt).not.toContain("## Run History");
    }
  });
});
