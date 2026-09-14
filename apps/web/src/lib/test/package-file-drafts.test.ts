// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "bun:test";
import {
  projectDraftFiles,
  stageFileOperations,
  packageUpdateBody,
  uploadedFileOperation,
  packageCreateBody,
  newPackageContent,
} from "../package-file-drafts";
import type { PackageFileEntry } from "../package-file-tree";
const entries: PackageFileEntry[] = [
  { path: "SKILL.md", size: 4, media_kind: "text", inline: "body" },
  { path: "notes.md", size: 8, media_kind: "text" },
];

describe("package draft operations", () => {
  it("creates from the final primary buffer and preserves ancillary operations", async () => {
    const binary = await uploadedFileOperation(
      "asset.bin",
      new Blob([new Uint8Array([0, 255, 128])]),
    );
    const state = {
      manifest: { name: "@org/new" },
      operations: stageFileOperations(
        [],
        [
          { op: "write", path: "prompt.md", text: "old" },
          { op: "write", path: "notes.md", text: "notes" },
          { op: "move", from: "notes.md", to: "README.md" },
          { op: "write", path: "prompt.md", text: "final prompt" },
          binary,
        ],
      ),
    };
    expect(packageCreateBody(state, "agent")).toEqual({
      manifest: state.manifest,
      content: "final prompt",
      operations: [
        { op: "write", path: "notes.md", text: "notes" },
        { op: "move", from: "notes.md", to: "README.md" },
        binary,
      ],
    });
    expect(newPackageContent("agent", state.operations)).toBe("final prompt");
  });
  it("reads an uploaded UTF-8 skill without losing its BOM", async () => {
    const op = await uploadedFileOperation("SKILL.md", new Blob(["\uFEFFbody"]));
    expect(packageCreateBody({ manifest: {}, operations: [op] }, "skill")).toEqual({
      manifest: {},
      content: "\uFEFFbody",
    });
    expect(
      newPackageContent("skill", [{ op: "write", path: "SKILL.md", bytes_base64: "/w==" }]),
    ).toBe("");
  });
  it("keeps optional integration documentation in the file tree", () => {
    const state = {
      manifest: { type: "integration" },
      operations: [{ op: "write" as const, path: "INTEGRATION.md", text: "docs" }],
    };
    expect(packageCreateBody(state, "integration")).toEqual({
      manifest: state.manifest,
      content: JSON.stringify(state.manifest, null, 2),
      operations: state.operations,
    });
  });
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
  it("sends manifest and files under the original token in one payload", () => {
    expect(
      packageUpdateBody({
        manifest: { description: "mine" },
        lock_version: 7,
        operations: [{ op: "delete", path: "notes.md" }],
      }),
    ).toEqual({
      manifest: { description: "mine" },
      lock_version: 7,
      operations: [{ op: "delete", path: "notes.md" }],
    });
  });
  it("omits an empty operation list", () => {
    expect(packageUpdateBody({ manifest: {}, lock_version: 2, operations: [] })).toEqual({
      manifest: {},
      lock_version: 2,
    });
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
