// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure run input-document naming logic: deterministic
 * collision-resolved workspace names + the duplicate-destination guard.
 */

import { describe, it, expect } from "bun:test";
import {
  assignWorkspaceNames,
  assertUniqueWorkspaceNames,
  toWorkspaceSegment,
} from "../../../src/services/run-document-naming.ts";
import { ApiError } from "../../../src/lib/errors.ts";

describe("assignWorkspaceNames", () => {
  it("suffixes a colliding name before its extension", () => {
    expect(assignWorkspaceNames(["report.pdf", "report.pdf"])).toEqual([
      "report.pdf",
      "report-2.pdf",
    ]);
  });

  it("resolves three colliding names deterministically", () => {
    expect(assignWorkspaceNames(["report.pdf", "report.pdf", "report.pdf"])).toEqual([
      "report.pdf",
      "report-2.pdf",
      "report-3.pdf",
    ]);
  });

  it("handles mixed extensions and a name with no extension", () => {
    expect(
      assignWorkspaceNames(["notes", "notes", "data.csv", "data.csv", "archive.tar.gz"]),
    ).toEqual(["notes", "notes-2", "data.csv", "data-2.csv", "archive.tar.gz"]);
  });

  it("suffixes two different raw names that converge after sanitization (no overwrite)", () => {
    // Both sanitize to `re_port.pdf` (space and `#` fold to `_`), so the second
    // must be suffixed rather than silently overwrite the first.
    const [first, second] = assignWorkspaceNames(["re port.pdf", "re#port.pdf"]);
    expect(first).toBe("re_port.pdf");
    expect(second).toBe("re_port-2.pdf");
    expect(first).not.toBe(second);
  });

  it("does not clobber an explicit later name that matches a generated suffix", () => {
    expect(assignWorkspaceNames(["report.pdf", "report.pdf", "report-2.pdf"])).toEqual([
      "report.pdf",
      "report-2.pdf",
      "report-2-2.pdf",
    ]);
  });

  it("is deterministic — same input list yields identical output twice", () => {
    const input = ["a.txt", "a.txt", "b", "a.txt", "b"];
    expect(assignWorkspaceNames(input)).toEqual(assignWorkspaceNames(input));
    expect(assignWorkspaceNames(input)).toEqual(["a.txt", "a-2.txt", "b", "a-3.txt", "b-2"]);
  });

  it("never emits an empty or dot-only workspace segment", () => {
    // `..`, `.` and `""` sanitize to unsafe/empty segments — folded to `file`,
    // then disambiguated so the container path-traversal guard never triggers.
    expect(assignWorkspaceNames(["..", ".", ""])).toEqual(["file", "file-2", "file-3"]);
  });
});

describe("toWorkspaceSegment", () => {
  it("reduces a name to a single safe ASCII segment", () => {
    expect(toWorkspaceSegment("naïve résumé.pdf")).toBe("naive_resume.pdf");
    expect(toWorkspaceSegment("a/b/c.txt")).toBe("a_b_c.txt");
  });

  it("folds traversal / empty names to a safe fallback", () => {
    expect(toWorkspaceSegment("..")).toBe("file");
    expect(toWorkspaceSegment("")).toBe("file");
  });
});

describe("assertUniqueWorkspaceNames", () => {
  it("passes a list of distinct workspace names", () => {
    expect(() => assertUniqueWorkspaceNames(["a.pdf", "a-2.pdf", "b.csv"])).not.toThrow();
  });

  it("rejects duplicate destinations with a typed 400", () => {
    try {
      assertUniqueWorkspaceNames(["report.pdf", "report.pdf"]);
      throw new Error("expected assertUniqueWorkspaceNames to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("duplicate_document_name");
    }
  });
});
