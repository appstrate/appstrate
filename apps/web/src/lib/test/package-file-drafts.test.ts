// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "bun:test";
import {
  projectDraftFiles,
  stageFileOperations,
  packageUpdateBody,
  uploadedFileOperation,
  importRefusal,
} from "../package-file-drafts";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import type { PackageFileEntry } from "../package-file-tree";
const entries: PackageFileEntry[] = [
  { path: "SKILL.md", size: 4, media_kind: "text", inline: "body" },
  { path: "notes.md", size: 8, media_kind: "text" },
];

describe("package draft operations", () => {
  it("coalesces typing without crossing a rename", () => {
    const operations = stageFileOperations(
      [],
      [
        { op: "write", path: "notes.md", text: "a" },
        { op: "write", path: "notes.md", text: "ab" },
        { op: "move", from: "notes.md", to: "other.md" },
        { op: "write", path: "other.md", text: "abc" },
      ],
    );
    expect(operations).toHaveLength(3);
    expect(
      projectDraftFiles(entries, operations, "skill").find((file) => file.path === "other.md")
        ?.inline,
    ).toBe("abc");
    expect(entries[1]?.path).toBe("notes.md");
  });
  it("keeps the original fetch path of an unmodified renamed file", () => {
    expect(
      projectDraftFiles(
        entries,
        [{ op: "move", from: "notes.md", to: "renamed.md" }],
        "skill",
      ).find((file) => file.path === "renamed.md"),
    ).toMatchObject({ path: "renamed.md", sourcePath: "notes.md" });
  });
  it("supports create, rename and delete before saving", () => {
    const files = projectDraftFiles(
      entries,
      [
        { op: "write", path: "new.txt", text: "new" },
        { op: "move", from: "new.txt", to: "moved.txt" },
        { op: "delete", path: "notes.md" },
      ],
      "skill",
    );
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "moved.txt"]);
    expect(files[1]?.inline).toBe("new");
  });
  it("sends manifest and files in one payload, the version riding in If-Match", () => {
    expect(
      packageUpdateBody({
        manifest: { description: "mine" },
        operations: [{ op: "delete", path: "notes.md" }],
      }),
    ).toEqual({
      manifest: { description: "mine" },
      operations: [{ op: "delete", path: "notes.md" }],
    });
  });
  it("omits an empty operation list", () => {
    expect(packageUpdateBody({ manifest: {}, operations: [] })).toEqual({ manifest: {} });
  });
  it("round-trips uploaded binary bytes", async () => {
    const operation = await uploadedFileOperation(
      "asset.bin",
      new Blob([new Uint8Array([0, 255, 128])]),
    );
    expect(operation).toEqual({ op: "write", path: "asset.bin", bytes_base64: "AP+A" });
    expect(
      projectDraftFiles(entries, [operation], "skill").find((file) => file.path === "asset.bin"),
    ).toMatchObject({ size: 3, media_kind: "binary" });
  });
  it("permits deleting optional integration documentation", () => {
    expect(
      projectDraftFiles(
        [{ path: "INTEGRATION.md", size: 1, media_kind: "text", inline: "x" }],
        [{ op: "delete", path: "INTEGRATION.md" }],
        "integration",
      ),
    ).toEqual([]);
  });
});

describe("importRefusal", () => {
  const file = (name: string, size = 1) => ({ name, size });
  it("accepts new names and a replacement of an existing path", () => {
    expect(importRefusal(entries, [file("a.md"), file("b.md")], false)).toBeNull();
    expect(importRefusal(entries, [file("notes.md")], true)).toBeNull();
  });
  it("refuses any file over the inline limit, replacement included", () => {
    const big = file("big.bin", PACKAGE_FILE_INLINE_MAX_BYTES + 1);
    expect(importRefusal(entries, [file("a.md"), big], false)).toEqual({
      key: "files.errorTooLarge",
    });
    expect(importRefusal(entries, [big], true)).toEqual({ key: "files.errorTooLarge" });
  });
  it("names the file that collides, with the tree or with the selection itself", () => {
    expect(importRefusal(entries, [file("notes.md")], false)).toEqual({
      key: "files.errorImportConflict",
      path: "notes.md",
    });
    expect(importRefusal(entries, [file("x.md"), file("x.md")], false)).toEqual({
      key: "files.errorImportConflict",
      path: "x.md",
    });
  });
  it("refuses the manifest's name with its own message", () => {
    expect(importRefusal(entries, [file("manifest.json")], false)).toEqual({
      key: "files.errorReserved",
      path: "manifest.json",
    });
  });
});
