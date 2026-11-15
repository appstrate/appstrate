// SPDX-License-Identifier: Apache-2.0

/** The per-type display file: each type's substance lives in its content file. */

import { PackageFileWriteError } from "@appstrate/core/package-file-operations";
import { describe, it, expect } from "bun:test";
import type { PackageType } from "@appstrate/core/validation";
import { ApiError } from "../../api/errors.ts";
import { packageFilesErrorKey, primaryDisplayFile } from "../package-files.ts";

const ALL_TYPES: PackageType[] = ["agent", "skill", "integration"];

describe("primaryDisplayFile", () => {
  it("names the file each type's substance actually lives in", () => {
    expect(primaryDisplayFile("agent")).toEqual({ name: "prompt.md" });
    expect(primaryDisplayFile("skill")).toEqual({ name: "SKILL.md" });
    expect(primaryDisplayFile("integration")).toEqual({ name: "INTEGRATION.md" });
  });

  it("is defined for every package type", () => {
    for (const type of ALL_TYPES) {
      expect(primaryDisplayFile(type).name).toMatch(/\S/);
    }
  });
});

describe("packageFilesErrorKey", () => {
  const refusal = (code: string, status: number) => new ApiError(code, "detail", status);

  it("names the concurrency loss, which is the one refusal with a recovery", () => {
    expect(packageFilesErrorKey(refusal("precondition_failed", 412))).toBe("files.errorConflict");
  });

  it("translates the shared local path errors", () => {
    expect(
      packageFilesErrorKey(new PackageFileWriteError("path_conflict", "file", "English message")),
    ).toBe("files.errorConflictPath");
  });

  it("keys on the machine-readable code, never on the status", () => {
    // Four different meanings share `400`; only `code` separates them.
    expect(packageFilesErrorKey(refusal("invalid_path", 400))).toBe("files.errorInvalidPath");
    expect(packageFilesErrorKey(refusal("reserved_entry", 400))).toBe("files.errorReserved");
    expect(packageFilesErrorKey(refusal("path_conflict", 400))).toBe("files.errorConflictPath");
    expect(packageFilesErrorKey(refusal("file_too_large", 413))).toBe("files.errorTooLarge");
    expect(packageFilesErrorKey(refusal("tree_too_large", 413))).toBe("files.errorTooLarge");
  });

  it("claims nothing for a refusal the editor cannot provoke", () => {
    expect(packageFilesErrorKey(refusal("content_entry_immovable", 400))).toBeNull();
    expect(packageFilesErrorKey(refusal("not_found", 404))).toBeNull();
    expect(packageFilesErrorKey(refusal("package_type_not_editable", 400))).toBeNull();
  });

  it("claims nothing for the manifest save's own refusals, which share the button", () => {
    // The skill editor's banner asks this first and the frontmatter translator
    // second; a blanket verdict here would swallow the specific message.
    expect(packageFilesErrorKey(refusal("validation_failed", 400))).toBeNull();
  });

  it("claims nothing for a failure that never reached the route at all", () => {
    // A network error is a plain `Error`: reading `.code` off it would be
    // `undefined` and match nothing, so the guard has to be on the class.
    expect(packageFilesErrorKey(new Error("network down"))).toBeNull();
    expect(packageFilesErrorKey(undefined)).toBeNull();
  });
});
