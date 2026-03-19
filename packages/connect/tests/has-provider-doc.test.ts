import { describe, test, expect } from "bun:test";

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
  test("returns true for PROVIDER.md content", () => {
    expect(hasProviderDoc("# Gmail API\n\nBase URL: ...")).toBe(true);
  });

  test("returns false for manifest JSON content", () => {
    expect(hasProviderDoc('{"name":"@test/provider","version":"1.0.0"}')).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasProviderDoc("")).toBe(false);
  });

  test("returns false for null", () => {
    expect(hasProviderDoc(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(hasProviderDoc(undefined)).toBe(false);
  });

  test("returns false for whitespace-only content", () => {
    expect(hasProviderDoc("   \n  ")).toBe(false);
  });

  test("returns true for markdown starting with text (no heading)", () => {
    expect(hasProviderDoc("This provider connects to the Gmail API.")).toBe(true);
  });
});
