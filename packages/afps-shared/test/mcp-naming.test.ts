// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  allocateMcpToolName,
  isValidMcpToolName,
  MCP_TOOL_NAME_MAX_LENGTH,
  normaliseMcpToolBody,
} from "../src/mcp-naming.ts";

const free = () => false;

describe("normaliseMcpToolBody", () => {
  it("changes only the characters LLM providers reject", () => {
    expect(normaliseMcpToolBody("getPage")).toBe("getPage");
    expect(normaliseMcpToolBody("list-issues")).toBe("list-issues");
    expect(normaliseMcpToolBody("drive__api.upload")).toBe("drive__api_upload");
    expect(normaliseMcpToolBody("__private")).toBe("__private");
  });

  it("maps one code point to one underscore", () => {
    expect(normaliseMcpToolBody("café 🙂")).toBe("caf___");
  });
});

describe("allocateMcpToolName", () => {
  it("returns the plain namespaced name when it is valid and free", () => {
    expect(allocateMcpToolName("gh", "listIssues", free)).toBe("gh__listIssues");
    expect(allocateMcpToolName("gh", "files.read", free)).toBe("gh__files_read");
  });

  it("hashes the ORIGINAL name on collision, independent of registration order", () => {
    const taken = (n: string) => n === "gh__list_issues";
    const a = allocateMcpToolName("gh", "list_issues", taken);
    const b = allocateMcpToolName("gh", "list.issues", taken);
    expect(a).toMatch(/^gh__list_issues_[0-9a-f]{8}$/);
    expect(b).toMatch(/^gh__list_issues_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(allocateMcpToolName("gh", "list_issues", taken)).toBe(a);
  });

  it("gives a name advertised twice one salted digest, then throws", () => {
    const first = allocateMcpToolName("gh", "x", (n) => n === "gh__x");
    const second = allocateMcpToolName("gh", "x", (n) => n === "gh__x" || n === first);
    expect(second).not.toBe(first);
    expect(isValidMcpToolName(second)).toBe(true);
    expect(allocateMcpToolName("gh", "x", (n) => n === "gh__x" || n === first)).toBe(second);
    expect(() =>
      allocateMcpToolName("gh", "x", (n) => n === "gh__x" || n === first || n === second),
    ).toThrow(/collides after re-hashing/);
  });

  it("truncates within the ceiling and keeps names that differ only past the cut apart", () => {
    const a = allocateMcpToolName("gh", `${"x".repeat(80)}a`, free);
    const b = allocateMcpToolName("gh", `${"x".repeat(80)}b`, free);
    expect(a).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH);
    expect(isValidMcpToolName(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("hashes an empty or wholly-unusable name to a valid body", () => {
    expect(isValidMcpToolName(allocateMcpToolName("gh", "", free))).toBe(true);
  });
});
