import { describe, expect, test } from "bun:test";
import {
  normalizeScope,
  stripScope,
  parseScopedName,
  buildPackageId,
  isOwnedByOrg,
} from "../src/naming.ts";

describe("normalizeScope", () => {
  test('"scope" → "@scope"', () => {
    expect(normalizeScope("scope")).toBe("@scope");
  });

  test('"@scope" → "@scope"', () => {
    expect(normalizeScope("@scope")).toBe("@scope");
  });

  test("throws on empty string", () => {
    expect(() => normalizeScope("")).toThrow("Scope cannot be empty");
  });
});

describe("stripScope", () => {
  test('"@scope" → "scope"', () => {
    expect(stripScope("@scope")).toBe("scope");
  });

  test('"scope" → "scope"', () => {
    expect(stripScope("scope")).toBe("scope");
  });
});

describe("parseScopedName", () => {
  test('"@acme/my-skill" → { scope: "acme", name: "my-skill" }', () => {
    expect(parseScopedName("@acme/my-skill")).toEqual({ scope: "acme", name: "my-skill" });
  });

  test('"invalid" → null', () => {
    expect(parseScopedName("invalid")).toBeNull();
  });

  test('"acme/skill" (no @) → null', () => {
    expect(parseScopedName("acme/skill")).toBeNull();
  });

  test('"@SCOPE/name" (uppercase scope) → null', () => {
    expect(parseScopedName("@SCOPE/name")).toBeNull();
  });

  test('"@scope/NAME" (uppercase name) → null', () => {
    expect(parseScopedName("@scope/NAME")).toBeNull();
  });

  test('"@scope/" (empty name) → null', () => {
    expect(parseScopedName("@scope/")).toBeNull();
  });

  test('"@-scope/name" (scope starts with hyphen) → null', () => {
    expect(parseScopedName("@-scope/name")).toBeNull();
  });

  test('"@scope/name-" (name ends with hyphen) → null', () => {
    expect(parseScopedName("@scope/name-")).toBeNull();
  });

  test('"@a/b" (single-char scope and name) → valid', () => {
    expect(parseScopedName("@a/b")).toEqual({ scope: "a", name: "b" });
  });

  test('"@org123/pkg-name" (alphanumeric with hyphens) → valid', () => {
    expect(parseScopedName("@org123/pkg-name")).toEqual({ scope: "org123", name: "pkg-name" });
  });
});

describe("isOwnedByOrg", () => {
  test('"@acme/flow" owned by "acme" → true', () => {
    expect(isOwnedByOrg("@acme/flow", "acme")).toBe(true);
  });

  test('"@other/flow" owned by "acme" → false', () => {
    expect(isOwnedByOrg("@other/flow", "acme")).toBe(false);
  });

  test('"invalid" owned by "acme" → false', () => {
    expect(isOwnedByOrg("invalid", "acme")).toBe(false);
  });

  test('"@acme-labs/flow" owned by "acme" → false (no partial match)', () => {
    expect(isOwnedByOrg("@acme-labs/flow", "acme")).toBe(false);
  });

  test('"@acme/flow" owned by "" → false', () => {
    expect(isOwnedByOrg("@acme/flow", "")).toBe(false);
  });
});

describe("buildPackageId", () => {
  test('("@acme", "my-skill") → "@acme/my-skill"', () => {
    expect(buildPackageId("@acme", "my-skill")).toBe("@acme/my-skill");
  });

  test('("acme", "skill") → "@acme/skill" (adds @ prefix)', () => {
    expect(buildPackageId("acme", "skill")).toBe("@acme/skill");
  });

  test('("@org", "a") → "@org/a"', () => {
    expect(buildPackageId("@org", "a")).toBe("@org/a");
  });
});
