// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for pure helpers in services/inline-run.ts. DB-touching helpers
 * (insertShadowPackage, deleteOrphanShadowPackage) are exercised by the
 * integration tests that call POST /api/runs/inline.
 */

import { describe, it, expect } from "bun:test";
import {
  INLINE_SHADOW_SCOPE,
  isInlineShadowPackageId,
  generateShadowPackageId,
  buildShadowLoadedPackage,
} from "../../src/services/inline-run.ts";
import type { AgentManifest } from "../../src/types/index.ts";

describe("inline-run helpers", () => {
  describe("INLINE_SHADOW_SCOPE", () => {
    it("is the reserved 'inline' scope", () => {
      expect(INLINE_SHADOW_SCOPE).toBe("inline");
    });
  });

  describe("isInlineShadowPackageId", () => {
    it("returns true for valid inline shadow ids", () => {
      expect(isInlineShadowPackageId("@inline/r-deadbeef")).toBe(true);
      expect(isInlineShadowPackageId(`@inline/r-${crypto.randomUUID()}`)).toBe(true);
    });

    it("returns false for regular package ids", () => {
      expect(isInlineShadowPackageId("@acme/agent")).toBe(false);
      expect(isInlineShadowPackageId("@system/log")).toBe(false);
    });

    it("returns false for scope names that merely contain 'inline'", () => {
      expect(isInlineShadowPackageId("@inliner/foo")).toBe(false);
      expect(isInlineShadowPackageId("@offline/agent")).toBe(false);
    });

    it("returns false for malformed ids", () => {
      expect(isInlineShadowPackageId("")).toBe(false);
      expect(isInlineShadowPackageId("inline/r-abc")).toBe(false);
      expect(isInlineShadowPackageId("inline")).toBe(false);
    });
  });

  describe("generateShadowPackageId", () => {
    it("returns a valid @inline/r-<uuid> id", () => {
      const id = generateShadowPackageId();
      expect(id).toMatch(/^@inline\/r-[0-9a-f-]{36}$/);
      expect(isInlineShadowPackageId(id)).toBe(true);
    });

    it("returns a new unique id on each call", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateShadowPackageId()));
      expect(ids.size).toBe(50);
    });
  });

  describe("buildShadowLoadedPackage", () => {
    const manifest: AgentManifest = {
      name: "@inline/r-test",
      displayName: "Shadow",
      version: "0.0.0",
      type: "agent",
      description: "Inline agent",
      schemaVersion: "1.0.0",
    } as AgentManifest;

    it("wraps manifest + prompt into a LoadedPackage with empty skills/tools", () => {
      const loaded = buildShadowLoadedPackage("@inline/r-1", manifest, "hello");
      expect(loaded).toEqual({
        id: "@inline/r-1",
        manifest,
        prompt: "hello",
        skills: [],
        tools: [],
        source: "local",
      });
    });

    it("preserves the exact prompt string (no trimming or normalization)", () => {
      const prompt = "  line1\n\n  line2  \n";
      const loaded = buildShadowLoadedPackage("@inline/r-2", manifest, prompt);
      expect(loaded.prompt).toBe(prompt);
    });

    it("applies resolved skills/tools when deps are passed", () => {
      const deps = {
        skills: [{ id: "@x/skill", version: "^1.0.0" }],
        tools: [{ id: "@x/tool", version: "^1.0.0" }],
      };
      const loaded = buildShadowLoadedPackage("@inline/r-3", manifest, "p", deps);
      expect(loaded.skills).toEqual(deps.skills);
      expect(loaded.tools).toEqual(deps.tools);
    });
  });
});
