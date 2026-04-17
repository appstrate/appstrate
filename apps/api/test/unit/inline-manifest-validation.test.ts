// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validateInlineManifest — all caps + structural dispatch.
 */

import { describe, it, expect } from "bun:test";
import { validateInlineManifest } from "../../src/services/inline-manifest-validation.ts";
import type { InlineRunLimits } from "../../src/services/run-limits.ts";

const defaults: InlineRunLimits = {
  rate_per_min: 60,
  manifest_bytes: 65536,
  prompt_bytes: 200_000,
  max_skills: 20,
  max_tools: 20,
  max_authorized_uris: 50,
  wildcard_uri_allowed: false,
  retention_days: 30,
};

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@acme/inline-test",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "Inline Test",
    author: "ACME",
    ...overrides,
  };
}

describe("validateInlineManifest — happy path", () => {
  it("accepts a minimal valid agent manifest", () => {
    const result = validateInlineManifest({
      manifest: baseManifest(),
      prompt: "Do the thing.",
      limits: defaults,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(result.canonicalManifestJson).toBeDefined();
    expect(result.canonicalManifestJson).toContain('"name":"@acme/inline-test"');
  });

  it("accepts a manifest with dependencies within caps", () => {
    const result = validateInlineManifest({
      manifest: baseManifest({
        dependencies: {
          skills: { "@sys/skill-a": "1.0.0", "@sys/skill-b": "^1" },
          tools: { "@sys/tool-a": "1.0.0" },
          providers: { "@sys/gmail": "1.0.0" },
        },
      }),
      prompt: "Use the tools.",
      limits: defaults,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Byte caps
// ---------------------------------------------------------------------------

describe("validateInlineManifest — size caps", () => {
  it("rejects prompts larger than prompt_bytes (ASCII)", () => {
    const tight = { ...defaults, prompt_bytes: 10 };
    const result = validateInlineManifest({
      manifest: baseManifest(),
      prompt: "x".repeat(11),
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("prompt: exceeds max size");
  });

  it("counts prompt bytes in utf-8 (emoji = 4 bytes each)", () => {
    // 4 bytes per emoji × 10 = 40 bytes, cap is 20 → reject.
    const tight = { ...defaults, prompt_bytes: 20 };
    const result = validateInlineManifest({
      manifest: baseManifest(),
      prompt: "😀".repeat(10),
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("prompt: exceeds max size");
  });

  it("rejects non-string prompts", () => {
    const result = validateInlineManifest({
      manifest: baseManifest(),
      prompt: 123,
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("prompt: must be a string");
  });

  it("rejects manifests larger than manifest_bytes", () => {
    const tight = { ...defaults, manifest_bytes: 100 };
    // Valid structure but padded description blows the byte cap
    const manifest = baseManifest({ description: "x".repeat(500) });
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("manifest: exceeds max size"))).toBe(true);
  });

  it("counts manifest bytes in utf-8", () => {
    // Each emoji is 4 bytes in utf-8, while .length reports 2 codepoints.
    const emoji = "😀".repeat(10); // 40 bytes in utf-8
    const tight = { ...defaults, manifest_bytes: 80 };
    const manifest = baseManifest({ description: emoji });
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural validation (delegates to validateManifest)
// ---------------------------------------------------------------------------

describe("validateInlineManifest — structural", () => {
  it("rejects non-object manifest", () => {
    const result = validateInlineManifest({
      manifest: "not an object",
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("manifest: must be a JSON object");
  });

  it("rejects array manifest", () => {
    const result = validateInlineManifest({
      manifest: [],
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects missing type field", () => {
    const { type: _type, ...noType } = baseManifest();
    const result = validateInlineManifest({
      manifest: noType,
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("type");
  });

  it("rejects malformed package name", () => {
    const result = validateInlineManifest({
      manifest: baseManifest({ name: "bad-name-no-scope" }),
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("@scope/name");
  });
});

// ---------------------------------------------------------------------------
// Dependency count caps
// ---------------------------------------------------------------------------

describe("validateInlineManifest — dependency caps", () => {
  function depsManifest(skillCount: number, toolCount: number): Record<string, unknown> {
    const skills: Record<string, string> = {};
    const tools: Record<string, string> = {};
    for (let i = 0; i < skillCount; i++) skills[`@sys/skill-${i}`] = "1.0.0";
    for (let i = 0; i < toolCount; i++) tools[`@sys/tool-${i}`] = "1.0.0";
    return baseManifest({ dependencies: { skills, tools } });
  }

  it("rejects too many skills", () => {
    const tight = { ...defaults, max_skills: 2 };
    const result = validateInlineManifest({
      manifest: depsManifest(3, 0),
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills: too many"))).toBe(true);
  });

  it("rejects too many tools", () => {
    const tight = { ...defaults, max_tools: 1 };
    const result = validateInlineManifest({
      manifest: depsManifest(0, 3),
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools: too many"))).toBe(true);
  });

  it("accepts exactly cap-many deps", () => {
    const tight = { ...defaults, max_skills: 2, max_tools: 2 };
    const result = validateInlineManifest({
      manifest: depsManifest(2, 2),
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects too many providers", () => {
    const providers: Record<string, string> = {};
    for (let i = 0; i < 5; i++) providers[`@sys/p-${i}`] = "1.0.0";
    const tight = { ...defaults, max_authorized_uris: 3 };
    const result = validateInlineManifest({
      manifest: baseManifest({ dependencies: { providers } }),
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("providers: too many"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wildcard + authorizedUris caps (defensive — applies to provider manifests)
// ---------------------------------------------------------------------------

describe("validateInlineManifest — wildcard/uri caps", () => {
  it("rejects allowAllUris when wildcard disabled", () => {
    const manifest = {
      ...baseManifest({ type: "provider" }),
      displayName: "P",
      definition: {
        authMode: "api_key",
        allowAllUris: true,
        credentials: {
          schema: { type: "object", properties: { apikey: { type: "string" } } },
          fieldName: "apikey",
        },
        credentialHeaderName: "X-Api-Key",
      },
    };
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("wildcard access is not allowed");
  });

  it('rejects explicit "*" entry in authorizedUris', () => {
    const manifest = {
      ...baseManifest({ type: "provider" }),
      displayName: "P",
      definition: {
        authMode: "api_key",
        authorizedUris: ["https://api.example.com", "*"],
        credentials: {
          schema: { type: "object", properties: { apikey: { type: "string" } } },
          fieldName: "apikey",
        },
        credentialHeaderName: "X-Api-Key",
      },
    };
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: defaults,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain('wildcard "*" entry is not allowed');
  });

  it("rejects too many authorizedUris", () => {
    const tight = { ...defaults, max_authorized_uris: 2 };
    const manifest = {
      ...baseManifest({ type: "provider" }),
      displayName: "P",
      definition: {
        authMode: "api_key",
        authorizedUris: ["a", "b", "c"],
        credentials: {
          schema: { type: "object", properties: { apikey: { type: "string" } } },
          fieldName: "apikey",
        },
        credentialHeaderName: "X-Api-Key",
      },
    };
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("authorizedUris: too many");
  });

  it("accepts wildcard when wildcard_uri_allowed is true", () => {
    const permissive = { ...defaults, wildcard_uri_allowed: true };
    const manifest = {
      ...baseManifest({ type: "provider" }),
      displayName: "P",
      definition: {
        authMode: "api_key",
        allowAllUris: true,
        credentials: {
          schema: { type: "object", properties: { apikey: { type: "string" } } },
          fieldName: "apikey",
        },
        credentialHeaderName: "X-Api-Key",
      },
    };
    const result = validateInlineManifest({
      manifest,
      prompt: "ok",
      limits: permissive,
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error aggregation
// ---------------------------------------------------------------------------

describe("validateInlineManifest — error aggregation", () => {
  it("reports multiple independent violations in one pass", () => {
    const tight = { ...defaults, max_skills: 0, max_tools: 0 };
    const manifest = baseManifest({
      dependencies: {
        skills: { "@x/a": "1.0.0" },
        tools: { "@x/b": "1.0.0" },
      },
    });
    const result = validateInlineManifest({
      manifest,
      prompt: "x".repeat(tight.prompt_bytes + 1),
      limits: tight,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
