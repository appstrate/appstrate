// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildBundleFromAfps } from "../../src/bundle/build.ts";
import { emptyPackageCatalog } from "../../src/bundle/catalog.ts";
import { validateBundle } from "../../src/bundle/validate-bundle.ts";
import { computeIntegrity, verifyIntegrity } from "../../src/bundle/hash.ts";
import { renderPrompt } from "../../src/bundle/prompt-renderer.ts";
import { zipSync } from "fflate";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const MANIFEST = {
  name: "@acme/research",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Research Agent",
  author: "Acme",
};

const PROMPT = [
  "Investigate {{input.topic}} for run {{runId}}.",
  "",
  "Known prior findings:",
  "{{#memories}}",
  "- {{content}}",
  "{{/memories}}",
  "{{^memories}}(no prior findings)\n{{/memories}}",
].join("\n");

describe("bundle integration — ingest .afps → validate → render", () => {
  const zip = zipSync({
    "manifest.json": enc(JSON.stringify(MANIFEST)),
    "prompt.md": enc(PROMPT),
  });

  it("ingests a single-package AFPS archive into a valid Bundle-of-1", async () => {
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    expect(bundle.root).toBe("@acme/research@1.0.0");
    const rootPkg = bundle.packages.get(bundle.root)!;
    expect(rootPkg.manifest.name).toBe("@acme/research");
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("produces a deterministic integrity hash and verifies against it", () => {
    const sri = computeIntegrity(zip);
    expect(verifyIntegrity(zip, sri).valid).toBe(true);
    const tampered = new Uint8Array(zip);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(verifyIntegrity(tampered, sri).valid).toBe(false);
  });

  it("renders the prompt template with memories carried on the ExecutionContext", async () => {
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    const rootPkg = bundle.packages.get(bundle.root)!;
    const template = new TextDecoder().decode(rootPkg.files.get("prompt.md")!);
    const rendered = await renderPrompt({
      template,
      context: {
        runId: "run_abc",
        input: { topic: "biology" },
        memories: [
          { content: "Plants photosynthesise.", createdAt: 1000 },
          { content: "Water boils at 100°C.", createdAt: 2000 },
        ],
      },
    });

    expect(rendered).toContain("Investigate biology for run run_abc.");
    expect(rendered).toContain("- Plants photosynthesise.");
    expect(rendered).toContain("- Water boils at 100°C.");
    expect(rendered).not.toContain("(no prior findings)");
  });

  it("falls through the inverted section when no memories are provided", async () => {
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    const rootPkg = bundle.packages.get(bundle.root)!;
    const template = new TextDecoder().decode(rootPkg.files.get("prompt.md")!);
    const rendered = await renderPrompt({
      template,
      context: { runId: "r", input: { topic: "x" } },
    });
    expect(rendered).toContain("(no prior findings)");
  });
});
