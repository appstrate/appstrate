// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

export interface LoadedBundle {
  /** Parsed `manifest.json` (raw JSON object — validation happens in `validator.ts`). */
  manifest: Record<string, unknown>;
  /** Contents of `prompt.md` (decoded UTF-8). */
  prompt: string;
  /**
   * All files in the bundle keyed by normalised posix path. The manifest
   * and prompt are also present here for tools that want to iterate the
   * whole tree. Wrapper folders (a single top-level directory) are
   * stripped transparently.
   */
  files: Readonly<Record<string, Uint8Array>>;
  /** Size of the compressed ZIP in bytes — carried for logging/telemetry. */
  compressedSize: number;
  /** Sum of decompressed file sizes — exposed for quota enforcement. */
  decompressedSize: number;
}

export interface LoadBundleOptions {
  /**
   * Cap on the compressed ZIP size (bytes). Default: 10 MiB. Prevents a
   * caller from tying up the process on an unreasonable input.
   */
  maxCompressedBytes?: number;
  /**
   * Cap on the sum of decompressed entry sizes (bytes). Default: 50 MiB.
   * Primary defence against ZIP-bomb inputs.
   */
  maxDecompressedBytes?: number;
}

const DEFAULT_MAX_COMPRESSED = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_DECOMPRESSED = 50 * 1024 * 1024; // 50 MiB

/**
 * Error thrown by the bundle loader. `code` is machine-readable and
 * stable — callers may branch on it to map to HTTP status codes or UI
 * copy. `details` carries structured context without forcing the
 * message to be machine-parseable.
 */
export class BundleLoadError extends Error {
  constructor(
    public readonly code:
      | "FILE_TOO_LARGE"
      | "ZIP_INVALID"
      | "ZIP_BOMB"
      | "MISSING_MANIFEST"
      | "INVALID_MANIFEST"
      | "MISSING_PROMPT"
      | "EMPTY_PROMPT",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BundleLoadError";
  }
}

/**
 * Load an AFPS bundle from an on-disk ZIP/AFPS file.
 *
 * Convenience wrapper around {@link loadBundleFromBuffer} — reads the
 * file once and delegates. Prefer the buffer form when the bytes are
 * already in memory (e.g. fetched over HTTP).
 */
export async function loadBundleFromFile(
  path: string,
  opts?: LoadBundleOptions,
): Promise<LoadedBundle> {
  const buffer = await readFile(path);
  return loadBundleFromBuffer(new Uint8Array(buffer), opts);
}

/**
 * Load an AFPS bundle from an in-memory ZIP buffer.
 *
 * Performs structural checks only — manifest validation against the
 * AFPS spec is handled separately by `validateBundle` in `validator.ts`
 * so callers can defer strict validation (e.g. inspect a malformed
 * manifest in a UI) without re-decoding the ZIP.
 *
 * Security: rejects inputs exceeding size caps; strips path-traversal,
 * absolute-path, null-byte, and backslash entries; ignores `__MACOSX`
 * metadata directories and any directory entries.
 */
export function loadBundleFromBuffer(
  buffer: Uint8Array,
  opts: LoadBundleOptions = {},
): LoadedBundle {
  const maxCompressed = opts.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED;
  const maxDecompressed = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED;

  if (buffer.length > maxCompressed) {
    throw new BundleLoadError(
      "FILE_TOO_LARGE",
      `bundle exceeds compressed-size limit of ${maxCompressed} bytes (got ${buffer.length})`,
    );
  }

  let rawFiles: Record<string, Uint8Array>;
  try {
    rawFiles = unzipSync(buffer);
  } catch (err) {
    throw new BundleLoadError(
      "ZIP_INVALID",
      `failed to decompress bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sanitized = sanitizeEntries(rawFiles);
  const decompressedSize = sumSizes(sanitized);
  if (decompressedSize > maxDecompressed) {
    throw new BundleLoadError(
      "ZIP_BOMB",
      `decompressed bundle (${decompressedSize} bytes) exceeds limit of ${maxDecompressed}`,
    );
  }

  const files = stripWrapperPrefix(sanitized);

  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) {
    throw new BundleLoadError("MISSING_MANIFEST", "bundle does not contain manifest.json");
  }

  const manifestText = new TextDecoder().decode(manifestBytes);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest.json must be a JSON object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (err) {
    throw new BundleLoadError(
      "INVALID_MANIFEST",
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const promptBytes = files["prompt.md"];
  if (!promptBytes) {
    throw new BundleLoadError("MISSING_PROMPT", "bundle does not contain prompt.md");
  }
  const prompt = new TextDecoder().decode(promptBytes);
  if (prompt.trim().length === 0) {
    throw new BundleLoadError("EMPTY_PROMPT", "prompt.md is empty");
  }

  return {
    manifest,
    prompt,
    files,
    compressedSize: buffer.length,
    decompressedSize,
  };
}

function sanitizeEntries(raw: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      key.startsWith("/") ||
      key.includes("\0") ||
      key.includes("\\") ||
      key.endsWith("/") ||
      key.startsWith("__MACOSX/") ||
      key.split("/").some((segment) => segment === "..")
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function stripWrapperPrefix(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const keys = Object.keys(files);
  if (keys.length === 0) return files;
  const prefixes = new Set<string>();
  for (const key of keys) {
    const slashIdx = key.indexOf("/");
    if (slashIdx === -1) return files;
    prefixes.add(key.slice(0, slashIdx));
  }
  if (prefixes.size !== 1) return files;
  const prefix = `${[...prefixes][0]!}/`;
  const stripped: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(files)) {
    stripped[key.slice(prefix.length)] = value;
  }
  return stripped;
}

function sumSizes(files: Record<string, Uint8Array>): number {
  let total = 0;
  for (const value of Object.values(files)) total += value.length;
  return total;
}
