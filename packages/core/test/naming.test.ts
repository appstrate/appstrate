// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  normalizeScope,
  stripScope,
  parseScopedName,
  buildPackageId,
  isOwnedByOrg,
  isValidToolNameForExisting,
  isValidToolNameForNew,
  normalizeToolName,
  TOOL_NAME_MAX_LEN,
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
  test('"@acme/my-agent" owned by "acme" → true', () => {
    expect(isOwnedByOrg("@acme/my-agent", "acme")).toBe(true);
  });

  test('"@other/my-agent" owned by "acme" → false', () => {
    expect(isOwnedByOrg("@other/my-agent", "acme")).toBe(false);
  });

  test('"invalid" owned by "acme" → false', () => {
    expect(isOwnedByOrg("invalid", "acme")).toBe(false);
  });

  test('"@acme-labs/my-agent" owned by "acme" → false (no partial match)', () => {
    expect(isOwnedByOrg("@acme-labs/my-agent", "acme")).toBe(false);
  });

  test('"@acme/my-agent" owned by "" → false', () => {
    expect(isOwnedByOrg("@acme/my-agent", "")).toBe(false);
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

describe("isValidToolNameForNew (Phase 4 / V13 strict predicate)", () => {
  test("accepts canonical {namespace}__{tool} snake_case", () => {
    expect(isValidToolNameForNew("fs__read_file")).toBe(true);
    expect(isValidToolNameForNew("notion__search_pages")).toBe(true);
    expect(isValidToolNameForNew("a__b")).toBe(true);
  });

  test("rejects names without the __ separator", () => {
    expect(isValidToolNameForNew("read_file")).toBe(false);
    expect(isValidToolNameForNew("fs_read_file")).toBe(false);
  });

  test("rejects mixed-case", () => {
    expect(isValidToolNameForNew("FS__readFile")).toBe(false);
    expect(isValidToolNameForNew("Fs__read_file")).toBe(false);
  });

  test("rejects hyphens (mixed separator hurts tokenisation per V3)", () => {
    expect(isValidToolNameForNew("mcp-fs__read_file")).toBe(false);
  });

  test("rejects digit-leading names on either side", () => {
    expect(isValidToolNameForNew("1fs__read_file")).toBe(false);
    expect(isValidToolNameForNew("fs__1file")).toBe(false);
  });

  test("rejects names exceeding TOOL_NAME_MAX_LEN", () => {
    const long = "a".repeat(60) + "__b";
    expect(long.length).toBeGreaterThan(TOOL_NAME_MAX_LEN);
    expect(isValidToolNameForNew(long)).toBe(false);
  });

  test("rejects empty / non-string input", () => {
    expect(isValidToolNameForNew("")).toBe(false);
    expect(isValidToolNameForNew(undefined as unknown as string)).toBe(false);
  });
});

describe("isValidToolNameForExisting (V13 lenient predicate)", () => {
  test("currently mirrors the strict predicate (no legacy surface yet)", () => {
    expect(isValidToolNameForExisting("fs__read_file")).toBe(true);
    expect(isValidToolNameForExisting("READ__FILE")).toBe(false);
  });
});

describe("normalizeToolName", () => {
  test("returns valid names unchanged", () => {
    expect(normalizeToolName("fs__read_file")).toBe("fs__read_file");
  });

  test("converts hyphens to underscores", () => {
    expect(normalizeToolName("mcp-fs__read-file")).toBe("mcp_fs__read_file");
  });

  test("promotes the first single-underscore boundary when no __ exists", () => {
    expect(normalizeToolName("fs_read_file")).toBe("fs__read_file");
  });

  test("lowercases mixed case", () => {
    expect(normalizeToolName("FS__readFile")).toBe("fs__readfile");
  });

  test("caps to TOOL_NAME_MAX_LEN", () => {
    const big = "a".repeat(80) + "__b";
    expect(normalizeToolName(big).length).toBe(TOOL_NAME_MAX_LEN);
  });
});
