// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
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
  it('"scope" → "@scope"', () => {
    expect(normalizeScope("scope")).toBe("@scope");
  });

  it('"@scope" → "@scope"', () => {
    expect(normalizeScope("@scope")).toBe("@scope");
  });

  it("throws on empty string", () => {
    expect(() => normalizeScope("")).toThrow("Scope cannot be empty");
  });
});

describe("stripScope", () => {
  it('"@scope" → "scope"', () => {
    expect(stripScope("@scope")).toBe("scope");
  });

  it('"scope" → "scope"', () => {
    expect(stripScope("scope")).toBe("scope");
  });
});

describe("parseScopedName", () => {
  it('"@acme/my-skill" → { scope: "acme", name: "my-skill" }', () => {
    expect(parseScopedName("@acme/my-skill")).toEqual({ scope: "acme", name: "my-skill" });
  });

  it('"invalid" → null', () => {
    expect(parseScopedName("invalid")).toBeNull();
  });

  it('"acme/skill" (no @) → null', () => {
    expect(parseScopedName("acme/skill")).toBeNull();
  });

  it('"@SCOPE/name" (uppercase scope) → null', () => {
    expect(parseScopedName("@SCOPE/name")).toBeNull();
  });

  it('"@scope/NAME" (uppercase name) → null', () => {
    expect(parseScopedName("@scope/NAME")).toBeNull();
  });

  it('"@scope/" (empty name) → null', () => {
    expect(parseScopedName("@scope/")).toBeNull();
  });

  it('"@-scope/name" (scope starts with hyphen) → null', () => {
    expect(parseScopedName("@-scope/name")).toBeNull();
  });

  it('"@scope/name-" (name ends with hyphen) → null', () => {
    expect(parseScopedName("@scope/name-")).toBeNull();
  });

  it('"@a/b" (single-char scope and name) → valid', () => {
    expect(parseScopedName("@a/b")).toEqual({ scope: "a", name: "b" });
  });

  it('"@org123/pkg-name" (alphanumeric with hyphens) → valid', () => {
    expect(parseScopedName("@org123/pkg-name")).toEqual({ scope: "org123", name: "pkg-name" });
  });
});

describe("isOwnedByOrg", () => {
  it('"@acme/my-agent" owned by "acme" → true', () => {
    expect(isOwnedByOrg("@acme/my-agent", "acme")).toBe(true);
  });

  it('"@other/my-agent" owned by "acme" → false', () => {
    expect(isOwnedByOrg("@other/my-agent", "acme")).toBe(false);
  });

  it('"invalid" owned by "acme" → false', () => {
    expect(isOwnedByOrg("invalid", "acme")).toBe(false);
  });

  it('"@acme-labs/my-agent" owned by "acme" → false (no partial match)', () => {
    expect(isOwnedByOrg("@acme-labs/my-agent", "acme")).toBe(false);
  });

  it('"@acme/my-agent" owned by "" → false', () => {
    expect(isOwnedByOrg("@acme/my-agent", "")).toBe(false);
  });
});

describe("buildPackageId", () => {
  it('("@acme", "my-skill") → "@acme/my-skill"', () => {
    expect(buildPackageId("@acme", "my-skill")).toBe("@acme/my-skill");
  });

  it('("acme", "skill") → "@acme/skill" (adds @ prefix)', () => {
    expect(buildPackageId("acme", "skill")).toBe("@acme/skill");
  });

  it('("@org", "a") → "@org/a"', () => {
    expect(buildPackageId("@org", "a")).toBe("@org/a");
  });
});

describe("isValidToolNameForNew (strict predicate)", () => {
  it("accepts canonical {namespace}__{tool} snake_case", () => {
    expect(isValidToolNameForNew("fs__read_file")).toBe(true);
    expect(isValidToolNameForNew("notion__search_pages")).toBe(true);
    expect(isValidToolNameForNew("a__b")).toBe(true);
  });

  it("rejects names without the __ separator", () => {
    expect(isValidToolNameForNew("read_file")).toBe(false);
    expect(isValidToolNameForNew("fs_read_file")).toBe(false);
  });

  it("rejects mixed-case", () => {
    expect(isValidToolNameForNew("FS__readFile")).toBe(false);
    expect(isValidToolNameForNew("Fs__read_file")).toBe(false);
  });

  it("rejects hyphens (mixed separator hurts tokenisation per V3)", () => {
    expect(isValidToolNameForNew("mcp-fs__read_file")).toBe(false);
  });

  it("rejects digit-leading names on either side", () => {
    expect(isValidToolNameForNew("1fs__read_file")).toBe(false);
    expect(isValidToolNameForNew("fs__1file")).toBe(false);
  });

  it("rejects names exceeding TOOL_NAME_MAX_LEN", () => {
    const long = "a".repeat(60) + "__b";
    expect(long.length).toBeGreaterThan(TOOL_NAME_MAX_LEN);
    expect(isValidToolNameForNew(long)).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isValidToolNameForNew("")).toBe(false);
    expect(isValidToolNameForNew(undefined as unknown as string)).toBe(false);
  });
});

describe("isValidToolNameForExisting (lenient predicate)", () => {
  it("currently mirrors the strict predicate", () => {
    expect(isValidToolNameForExisting("fs__read_file")).toBe(true);
    expect(isValidToolNameForExisting("READ__FILE")).toBe(false);
  });
});

describe("normalizeToolName", () => {
  it("returns valid names unchanged", () => {
    expect(normalizeToolName("fs__read_file")).toBe("fs__read_file");
  });

  it("converts hyphens to underscores", () => {
    expect(normalizeToolName("mcp-fs__read-file")).toBe("mcp_fs__read_file");
  });

  it("promotes the first single-underscore boundary when no __ exists", () => {
    expect(normalizeToolName("fs_read_file")).toBe("fs__read_file");
  });

  it("lowercases mixed case", () => {
    expect(normalizeToolName("FS__readFile")).toBe("fs__readfile");
  });

  it("caps to TOOL_NAME_MAX_LEN", () => {
    const big = "a".repeat(80) + "__b";
    expect(normalizeToolName(big).length).toBe(TOOL_NAME_MAX_LEN);
  });
});
