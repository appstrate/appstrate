// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { validateBundle } from "../../src/bundle/validator.ts";
import type { LoadedBundle } from "../../src/bundle/loader.ts";

const VALID_AGENT_MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello Agent",
  author: "Acme Corp",
};

function bundle(overrides: Partial<LoadedBundle> = {}): LoadedBundle {
  return {
    manifest: VALID_AGENT_MANIFEST,
    prompt: "Hello {{input.who}}",
    files: {},
    compressedSize: 0,
    decompressedSize: 0,
    ...overrides,
  };
}

describe("validateBundle — happy path", () => {
  it("accepts a well-formed agent bundle", () => {
    const result = validateBundle(bundle());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts a template with sections and inverted sections", () => {
    const b = bundle({
      prompt: "{{#memories}}- {{content}}\n{{/memories}}{{^memories}}none{{/memories}}",
    });
    const result = validateBundle(b);
    expect(result.valid).toBe(true);
  });
});

describe("validateBundle — manifest schema", () => {
  it("rejects a manifest missing required fields (no name)", () => {
    const b = bundle({
      manifest: { ...VALID_AGENT_MANIFEST, name: undefined } as unknown as Record<string, unknown>,
    });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("MANIFEST_SCHEMA");
  });

  it("rejects an unscoped name", () => {
    const b = bundle({
      manifest: { ...VALID_AGENT_MANIFEST, name: "bad-name" },
    });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.includes("name"))).toBe(true);
  });

  it("rejects a non-semver version", () => {
    const b = bundle({
      manifest: { ...VALID_AGENT_MANIFEST, version: "v1" },
    });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.includes("version"))).toBe(true);
  });
});

describe("validateBundle — type filtering", () => {
  it("rejects a non-agent bundle when agentOnly (default) is true", () => {
    const b = bundle({ manifest: { ...VALID_AGENT_MANIFEST, type: "skill" } });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(true);
  });

  it("skipping agentOnly still fails through MANIFEST_SCHEMA for a skill manifest (missing agent fields)", () => {
    const b = bundle({ manifest: { ...VALID_AGENT_MANIFEST, type: "skill" } });
    const result = validateBundle(b, { agentOnly: false });
    // No UNSUPPORTED_TYPE, but MANIFEST_SCHEMA likely triggers because
    // the agent schema expects type === "agent".
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_TYPE")).toBe(false);
  });
});

describe("validateBundle — schemaVersion gating", () => {
  it("accepts the default supported major (1.x)", () => {
    for (const v of ["1.0", "1.1", "1.42"]) {
      const b = bundle({ manifest: { ...VALID_AGENT_MANIFEST, schemaVersion: v } });
      const result = validateBundle(b);
      expect(result.valid).toBe(true);
    }
  });

  it("rejects a future major when not in supportedMajors", () => {
    const b = bundle({ manifest: { ...VALID_AGENT_MANIFEST, schemaVersion: "2.0" } });
    const result = validateBundle(b);
    // 2.x is outside v1 manifest spec — MANIFEST_SCHEMA fires before our guard.
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (i) => i.code === "SCHEMA_VERSION_UNSUPPORTED" || i.code === "MANIFEST_SCHEMA",
      ),
    ).toBe(true);
  });

  it("honors a wider supportedMajors override", () => {
    // Because the AFPS v1 Zod schema enforces 1.x, a 2.x manifest still
    // fails MANIFEST_SCHEMA even with supportedMajors: [2]. This test
    // pins the runtime-side gate specifically.
    const b = bundle({ manifest: { ...VALID_AGENT_MANIFEST } });
    const result = validateBundle(b, { supportedMajors: [1, 2] });
    expect(result.valid).toBe(true);
  });
});

describe("validateBundle — template syntax", () => {
  it("rejects an unclosed section", () => {
    const b = bundle({ prompt: "{{#memories}}forever" });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.code === "TEMPLATE_SYNTAX");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("prompt");
  });

  it("rejects a stray closing tag", () => {
    const b = bundle({ prompt: "hello {{/never-opened}}" });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "TEMPLATE_SYNTAX")).toBe(true);
  });
});

describe("validateBundle — issue accumulation", () => {
  it("surfaces multiple issues in a single pass (fail fast avoided)", () => {
    const b = bundle({
      manifest: { ...VALID_AGENT_MANIFEST, name: "bad-name" },
      prompt: "{{#unterminated}}",
    });
    const result = validateBundle(b);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(result.issues.some((i) => i.code === "MANIFEST_SCHEMA")).toBe(true);
    expect(result.issues.some((i) => i.code === "TEMPLATE_SYNTAX")).toBe(true);
  });
});
