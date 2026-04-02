// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";

/**
 * Test the hasProviderDoc heuristic used by getProvider() in registry.ts.
 * The logic: content.length > 0 && !content.startsWith("{")
 * Determines if draftContent is a PROVIDER.md (markdown) vs manifest JSON.
 */

function hasProviderDoc(draftContent: string | null | undefined): boolean {
  const content = draftContent?.trim() ?? "";
  return content.length > 0 && !content.startsWith("{");
}

describe("hasProviderDoc heuristic", () => {
  it("returns true for PROVIDER.md content", () => {
    expect(hasProviderDoc("# Gmail API\n\nBase URL: ...")).toBe(true);
  });

  it("returns false for manifest JSON content", () => {
    expect(hasProviderDoc('{"name":"@test/provider","version":"1.0.0"}')).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasProviderDoc("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(hasProviderDoc(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasProviderDoc(undefined)).toBe(false);
  });

  it("returns false for whitespace-only content", () => {
    expect(hasProviderDoc("   \n  ")).toBe(false);
  });

  it("returns true for markdown starting with text (no heading)", () => {
    expect(hasProviderDoc("This provider connects to the Gmail API.")).toBe(true);
  });
});
