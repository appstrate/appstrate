// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  applyFileTreeOperations,
  decodePackageFileText,
  PackageFileWriteError,
} from "../src/package-file-operations.ts";

describe("portable file operations", () => {
  it.each([
    ["scripts", "Scripts/run.py"],
    ["Scripts/run.py", "scripts"],
    ["café", "cafe\u0301/run.py"],
    ["README.md", "readme.md"],
  ])("rejects canonical file/directory collisions: %s and %s", (existing, added) => {
    expect(() =>
      applyFileTreeOperations(
        { [existing]: "original" },
        [{ op: "write", path: added, value: "new" }],
        "skill",
      ),
    ).toThrow(PackageFileWriteError);
  });

  it("keeps legacy case collisions editable without allowing a new one", () => {
    const files = { "A.md": "a", "a.md": "b" };
    expect(
      applyFileTreeOperations(files, [{ op: "write", path: "A.md", value: "updated" }], "skill")[
        "A.md"
      ],
    ).toBe("updated");
    expect(files["A.md"]).toBe("a");
  });

  it("refuses prototype setter names that ZIP libraries cannot round-trip", () => {
    expect(() =>
      applyFileTreeOperations({}, [{ op: "write", path: "__proto__", value: "data" }], "skill"),
    ).toThrow("usable file path");
  });

  it("preserves ordinary prototype property names as own files", () => {
    const result = applyFileTreeOperations(
      {},
      [
        { op: "write", path: "constructor", value: "data" },
        { op: "move", from: "constructor", to: "toString" },
      ],
      "skill",
    );
    expect(Object.entries(result)).toEqual([["toString", "data"]]);
  });
});

describe("decodePackageFileText", () => {
  it("returns the text of strict UTF-8, keeping a leading BOM", () => {
    expect(decodePackageFileText(new TextEncoder().encode("héllo"))).toBe("héllo");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    const text = decodePackageFileText(bom);
    expect(text).toBe("﻿a");
    expect(new TextEncoder().encode(text!)).toEqual(bom);
  });

  it("returns null for bytes that are not UTF-8", () => {
    expect(decodePackageFileText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]))).toBeNull();
  });
});
