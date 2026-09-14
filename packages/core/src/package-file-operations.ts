// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "./validation.ts";
import { PACKAGE_CONTENT_ENTRY, PACKAGE_MANIFEST_FILE } from "./package-files.ts";
import { isSafeArchivePath } from "./zip.ts";

/** The same tree algebra over stored bytes and the editor's file entries. */
export type FileTreeOperation<T> =
  | { op: "write"; path: string; value: T }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

export type PackageFileWriteErrorCode =
  | "invalid_bundle"
  | "invalid_path"
  | "reserved_entry"
  | "content_entry_immovable"
  | "not_found"
  | "path_conflict"
  | "file_too_large"
  | "tree_too_large";

export class PackageFileWriteError extends Error {
  constructor(
    readonly code: PackageFileWriteErrorCode,
    readonly path: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PackageFileWriteError";
  }
}

export function isProtectedPackageFile(type: PackageType, path: string): boolean {
  const entry = PACKAGE_CONTENT_ENTRY[type];
  return path === PACKAGE_MANIFEST_FILE || (entry?.required === true && path === entry.path);
}

function assertPath(path: string): void {
  if (!isSafeArchivePath(path) || path.split("/").includes("__proto__"))
    throw new PackageFileWriteError("invalid_path", path, `'${path}' is not a usable file path`);
  if (path === PACKAGE_MANIFEST_FILE)
    throw new PackageFileWriteError(
      "reserved_entry",
      path,
      "Edit the manifest through the package manifest field",
    );
}

function canonicalPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Validate new names, leaving pre-existing archive collisions editable. */
function assertNames<T>(files: Record<string, T>, added: Iterable<string>): void {
  const names = new Map<string, string[]>();
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const key = canonicalPath(path);
    names.set(key, [...(names.get(key) ?? []), path]);
    for (let cut = key.indexOf("/"); cut >= 0; cut = key.indexOf("/", cut + 1))
      directories.add(key.slice(0, cut));
  }
  for (const path of added) {
    const key = canonicalPath(path);
    if ((names.get(key)?.length ?? 0) > 1 || directories.has(key)) {
      throw new PackageFileWriteError(
        "path_conflict",
        path,
        `'${path}' conflicts with another file or directory`,
      );
    }
    for (let cut = key.indexOf("/"); cut >= 0; cut = key.indexOf("/", cut + 1)) {
      if (names.has(key.slice(0, cut)))
        throw new PackageFileWriteError(
          "path_conflict",
          path,
          `'${path}' has a file as an ancestor`,
        );
    }
  }
}

/** Ordered operations; validates the result without mutating the source tree. */
export function applyFileTreeOperations<T>(
  files: Record<string, T>,
  operations: readonly FileTreeOperation<T>[],
  type: PackageType,
): Record<string, T> {
  // Avoid inherited properties when looking up archive names.
  const result: Record<string, T> = Object.assign(Object.create(null), files);
  for (const operation of operations) {
    if (operation.op === "write") {
      assertPath(operation.path);
      result[operation.path] = operation.value;
      continue;
    }
    const source = operation.op === "move" ? operation.from : operation.path;
    assertPath(source);
    if (isProtectedPackageFile(type, source))
      throw new PackageFileWriteError(
        "content_entry_immovable",
        source,
        `'${source}' is required and cannot be removed or renamed`,
      );
    if (!Object.prototype.hasOwnProperty.call(result, source))
      throw new PackageFileWriteError("not_found", source, `'${source}' does not exist`);
    if (operation.op === "move") {
      assertPath(operation.to);
      if (operation.to === source) continue;
      if (Object.prototype.hasOwnProperty.call(result, operation.to))
        throw new PackageFileWriteError(
          "path_conflict",
          operation.to,
          `'${operation.to}' already exists`,
        );
      result[operation.to] = result[source]!;
    }
    delete result[source];
  }
  assertNames(
    result,
    Object.keys(result).filter((path) => !Object.prototype.hasOwnProperty.call(files, path)),
  );
  return result;
}
