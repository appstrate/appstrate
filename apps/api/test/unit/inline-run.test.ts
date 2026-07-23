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
  assertPromptDocumentsCoveredByInput,
} from "../../src/services/inline-run.ts";
import { ApiError } from "../../src/lib/errors.ts";
import type { AgentManifest } from "../../src/types/index.ts";
import type { JSONSchemaObject } from "@appstrate/core/form";

const DOC_A = "document://doc_aaaaaaaa";
const DOC_B = "document://doc_bbbbbbbb";

// A manifest input schema declaring `file` (and `also`) as FILE fields
// (`format:"uri"` + `contentMediaType`) — the only fields whose `document://`
// values are mounted into the run workspace. Any other property is a plain
// string field whose `document://` value never mounts.
const FILE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
    also: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
    note: { type: "string" },
  },
} as unknown as JSONSchemaObject;

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
      display_name: "Shadow",
      version: "0.0.0",
      type: "agent",
      description: "Inline agent",
      schema_version: "0.1",
      author: "test",
    } as AgentManifest;

    it("wraps manifest + prompt into a LoadedPackage — definition only", () => {
      const loaded = buildShadowLoadedPackage("@inline/r-1", manifest, "hello");
      expect(loaded).toEqual({
        id: "@inline/r-1",
        manifest,
        prompt: "hello",
        source: "local",
      });
    });

    it("preserves the exact prompt string (no trimming or normalization)", () => {
      const prompt = "  line1\n\n  line2  \n";
      const loaded = buildShadowLoadedPackage("@inline/r-2", manifest, prompt);
      expect(loaded.prompt).toBe(prompt);
    });

    // A shadow package carries no derived closure: the declared skills are
    // projected off `manifest.dependencies.skills` at the point of use (#878).
    it("carries no resolved-skill projection", () => {
      const loaded = buildShadowLoadedPackage("@inline/r-3", manifest, "p");
      expect(loaded).not.toHaveProperty("skills");
    });
  });

  describe("assertPromptDocumentsCoveredByInput", () => {
    it("rejects a prompt document:// URI absent from the input", () => {
      let caught: unknown;
      try {
        assertPromptDocumentsCoveredByInput(`Read the file at ${DOC_A} please.`, null, undefined);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("validation_failed");
      expect(apiErr.fieldErrors?.[0]?.code).toBe("document_uri_in_prompt");
      // The offending URI is named so the model knows what to move into input.
      expect(apiErr.fieldErrors?.[0]?.message).toContain(DOC_A);
    });

    it("names every uncovered URI when several are pasted into the prompt", () => {
      let caught: unknown;
      try {
        assertPromptDocumentsCoveredByInput(`Images: ${DOC_A} and ${DOC_B}`, null, undefined);
      } catch (err) {
        caught = err;
      }
      const msg = (caught as ApiError).fieldErrors?.[0]?.message ?? "";
      expect(msg).toContain(DOC_A);
      expect(msg).toContain(DOC_B);
    });

    it("passes when the prompt URI is mounted through a declared file field", () => {
      expect(() =>
        assertPromptDocumentsCoveredByInput(`Read ${DOC_A}`, { file: DOC_A }, FILE_SCHEMA),
      ).not.toThrow();
    });

    it("passes when every prompt URI is covered even if input carries extra file fields", () => {
      expect(() =>
        assertPromptDocumentsCoveredByInput(
          `Read ${DOC_A}`,
          { file: DOC_A, also: DOC_B },
          FILE_SCHEMA,
        ),
      ).not.toThrow();
    });

    it("rejects when only some prompt URIs are mounted by file fields", () => {
      expect(() =>
        assertPromptDocumentsCoveredByInput(`${DOC_A} and ${DOC_B}`, { file: DOC_A }, FILE_SCHEMA),
      ).toThrow(ApiError);
    });

    // Behavior change: a URI placed in a NON-file input field is inert — it
    // never mounts, so a prompt reference to it is uncovered and must throw.
    // The old whole-input walk counted it as covered (false negative).
    it("rejects a prompt URI whose only input occurrence is a non-file field", () => {
      let caught: unknown;
      try {
        assertPromptDocumentsCoveredByInput(`Read ${DOC_A}`, { note: DOC_A }, FILE_SCHEMA);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).fieldErrors?.[0]?.code).toBe("document_uri_in_prompt");
      expect((caught as ApiError).fieldErrors?.[0]?.message).toContain(DOC_A);
    });

    // With no schema, nothing mounts — every prompt URI is uncovered.
    it("rejects a prompt URI when the manifest declares no input schema", () => {
      expect(() =>
        assertPromptDocumentsCoveredByInput(`Read ${DOC_A}`, { file: DOC_A }, undefined),
      ).toThrow(ApiError);
    });

    it("passes for a prompt with no document:// URIs", () => {
      expect(() =>
        assertPromptDocumentsCoveredByInput("Summarise the user's recent emails.", null, undefined),
      ).not.toThrow();
    });
  });
});
