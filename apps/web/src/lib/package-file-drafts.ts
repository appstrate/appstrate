// SPDX-License-Identifier: Apache-2.0

import { applyFileTreeOperations } from "@appstrate/core/package-file-operations";
import type { PackageType } from "@appstrate/core/validation";
import type { PackageFileEntry, PackageFileWriteOperation } from "./package-file-tree";

export interface DraftFile extends PackageFileEntry {
  /** Original server path, retained by renames until the whole draft is saved. */
  sourcePath?: string;
}

function writtenEntry(operation: Extract<PackageFileWriteOperation, { op: "write" }>): DraftFile {
  const bytes =
    operation.text !== undefined
      ? new TextEncoder().encode(operation.text)
      : Uint8Array.from(atob(operation.bytes_base64!), (char) => char.charCodeAt(0));
  try {
    return {
      path: operation.path,
      size: bytes.byteLength,
      media_kind: "text",
      inline: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { path: operation.path, size: bytes.byteLength, media_kind: "binary" };
  }
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
  lock_version?: number;
  operations?: PackageFileWriteOperation[];
}) {
  return {
    manifest: state.manifest,
    lock_version: state.lock_version!,
    ...(state.operations?.length ? { operations: state.operations } : {}),
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
