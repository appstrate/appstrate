// SPDX-License-Identifier: Apache-2.0

import {
  applyFileTreeOperations,
  decodePackageFileText,
} from "@appstrate/core/package-file-operations";
import {
  PACKAGE_CONTENT_ENTRY,
  PACKAGE_FILE_INLINE_MAX_BYTES,
} from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import {
  validateNewPath,
  NEW_PATH_ERROR_KEYS,
  type PackageFileEntry,
  type PackageFileWriteOperation,
} from "./package-file-tree";

export interface DraftFile extends PackageFileEntry {
  /** Original server path, retained by renames until the whole draft is saved. */
  sourcePath?: string;
}

function writtenEntry(operation: Extract<PackageFileWriteOperation, { op: "write" }>): DraftFile {
  const bytes =
    operation.text !== undefined
      ? new TextEncoder().encode(operation.text)
      : Uint8Array.from(atob(operation.bytes_base64!), (char) => char.charCodeAt(0));
  // The server's own test (`buildFileIndex`), so a staged file is projected as
  // the kind the index will list once it is saved.
  const text = decodePackageFileText(bytes);
  return text === null
    ? { path: operation.path, size: bytes.byteLength, media_kind: "binary" }
    : { path: operation.path, size: bytes.byteLength, media_kind: "text", inline: text };
}

/** Project staged operations without a network write or a second tree reducer. */
export function projectDraftFiles(
  entries: readonly PackageFileEntry[],
  operations: readonly PackageFileWriteOperation[],
  type: PackageType,
): DraftFile[] {
  const base = Object.fromEntries(
    entries.map((entry) => [entry.path, { ...entry, sourcePath: entry.path }]),
  );
  const result = applyFileTreeOperations<DraftFile>(
    base,
    operations.map((operation) =>
      operation.op === "write"
        ? { op: "write", path: operation.path, value: writtenEntry(operation) }
        : operation,
    ),
    type,
  );
  return Object.entries(result).map(([path, entry]) => ({ ...entry, path }));
}

/** Coalesce typing until the next structural operation on that file. */
export function stageFileOperations(
  current: readonly PackageFileWriteOperation[],
  added: readonly PackageFileWriteOperation[],
): PackageFileWriteOperation[] {
  const result = [...current];
  for (const operation of added) {
    if (operation.op === "write") {
      let index = result.length - 1;
      for (; index >= 0; index--) {
        const previous = result[index]!;
        if (
          previous.op === "move"
            ? previous.from === operation.path || previous.to === operation.path
            : previous.path === operation.path
        )
          break;
      }
      if (index >= 0 && result[index]!.op === "write") {
        result[index] = operation;
        continue;
      }
    }
    result.push(operation);
  }
  return result;
}

export function fileTextOperation(path: string, text: string): PackageFileWriteOperation {
  return { op: "write", path, text };
}

export function packageUpdateBody(state: {
  manifest: Record<string, unknown>;
  operations?: PackageFileWriteOperation[];
}) {
  return {
    manifest: state.manifest,
    ...(state.operations?.length ? { operations: state.operations } : {}),
  };
}

/** Read the new package's content from its only editor buffer: staged files. */
export function newPackageContent(
  type: PackageType,
  operations: readonly PackageFileWriteOperation[],
): string {
  const entry = PACKAGE_CONTENT_ENTRY[type];
  return entry
    ? (projectDraftFiles([], operations, type).find((file) => file.path === entry.path)?.inline ??
        "")
    : "";
}

/** Keep the existing create contract without sending the primary file twice. */
export function packageCreateBody(
  state: { manifest: Record<string, unknown>; operations?: PackageFileWriteOperation[] },
  type: PackageType,
) {
  const entry = PACKAGE_CONTENT_ENTRY[type];
  const requiredPath = entry?.required ? entry.path : undefined;
  const operations = (state.operations ?? []).filter(
    (operation) => operation.op !== "write" || operation.path !== requiredPath,
  );
  return {
    manifest: state.manifest,
    content: requiredPath
      ? newPackageContent(type, state.operations ?? [])
      : JSON.stringify(state.manifest, null, 2),
    ...(operations.length ? { operations } : {}),
  };
}

export async function uploadedFileOperation(
  path: string,
  file: Blob,
): Promise<PackageFileWriteOperation> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Chunking avoids an argument-count overflow for files near the size limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { op: "write", path, bytes_base64: btoa(binary) };
}

/**
 * Why an import is refused, as a `files` message key, checked over the whole
 * selection before any file is read. Each imported name is planned into the
 * tree, so one selection cannot overwrite itself. A replacement keeps its path.
 */
export function importRefusal(
  entries: readonly PackageFileEntry[],
  files: readonly { name: string; size: number }[],
  replacing: boolean,
): { key: string; path?: string } | null {
  if (files.some((file) => file.size > PACKAGE_FILE_INLINE_MAX_BYTES))
    return { key: "files.errorTooLarge" };
  if (replacing) return null;
  const planned = [...entries];
  for (const file of files) {
    const rejection = validateNewPath(planned, file.name);
    if (rejection)
      return {
        key:
          rejection === "exists" || rejection === "conflict"
            ? "files.errorImportConflict"
            : NEW_PATH_ERROR_KEYS[rejection],
        path: file.name,
      };
    planned.push({ path: file.name, size: file.size, media_kind: "binary" });
  }
  return null;
}
