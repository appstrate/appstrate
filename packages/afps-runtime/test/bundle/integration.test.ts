// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { loadBundleFromBuffer } from "../../src/bundle/loader.ts";
import { validateBundle } from "../../src/bundle/validator.ts";
import { computeIntegrity, verifyIntegrity } from "../../src/bundle/hash.ts";
import { renderPrompt } from "../../src/bundle/prompt-renderer.ts";

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

describe("bundle integration — build → load → validate → render", () => {
  const zip = zipSync({
    "manifest.json": enc(JSON.stringify(MANIFEST)),
    "prompt.md": enc(PROMPT),
  });

  it("round-trips through loader + validator with no issues", () => {
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.manifest.name).toBe("@acme/research");
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("produces a deterministic integrity hash and verifies against it", () => {
    const sri = computeIntegrity(zip);
    expect(verifyIntegrity(zip, sri).valid).toBe(true);
    // A one-byte mutation fails the check.
    const tampered = new Uint8Array(zip);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(verifyIntegrity(tampered, sri).valid).toBe(false);
  });

  it("renders the prompt template with memories carried on the ExecutionContext", async () => {
    const bundle = loadBundleFromBuffer(zip);

    const rendered = await renderPrompt({
      template: bundle.prompt,
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
    const bundle = loadBundleFromBuffer(zip);
    const rendered = await renderPrompt({
      template: bundle.prompt,
      context: { runId: "r", input: { topic: "x" } },
    });
    expect(rendered).toContain("(no prior findings)");
  });
});
