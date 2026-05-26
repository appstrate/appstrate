// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { unzipSync, zipSync, type Zippable } from "fflate";
import {
  validateManifest,
  extractSkillMeta,
  type Manifest,
  type AgentManifest,
  type SkillManifest,
  type PackageType,
  type IntegrationManifest,
  type McpServerManifest,
} from "./validation.ts";

export type { Zippable };

/**
 * Fixed modification time stamped on every ZIP entry. fflate defaults each
 * entry's mtime to the current clock, which makes archive bytes — and thus
 * their integrity hash — change on every build even when the contents are
 * identical. ZIP mtimes are never read back (`unzipArtifact` discards them),
 * so pinning a constant costs nothing and makes the output reproducible.
 * Reproducibility is what lets the system-package loader treat an integrity
 * drift as a genuine content change (forgotten version bump) rather than
 * rebuild noise. 2020-01-01 UTC — any constant ≥ 1980 works (DOS time epoch).
 */
const DETERMINISTIC_MTIME = new Date("2020-01-01T00:00:00Z");

/**
 * Create a ZIP archive from a set of file entries.
 *
 * Output is deterministic: entries are emitted in sorted path order with a
 * fixed mtime, so identical inputs always produce identical bytes regardless
 * of filesystem `readdir` order or wall-clock time.
 *
 * @param entries - Map of file paths to Uint8Array content
 * @param level - Compression level (0=none, 9=max). Defaults to 6.
 * @returns The compressed ZIP as a Uint8Array
 * @throws Error if any entry value is not a Uint8Array (prevents fflate infinite recursion)
 */
export function zipArtifact(
  entries: Zippable,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array {
  // Guard against non-Uint8Array values that cause infinite recursion in fflate's fltn
  for (const [key, val] of Object.entries(entries)) {
    const actual = Array.isArray(val) ? val[0] : val;
    if (actual !== null && actual !== undefined && !(actual instanceof Uint8Array)) {
      const type = typeof actual;
      const ctor = (actual as object)?.constructor?.name ?? "unknown";
      throw new Error(
        `zipArtifact: entry "${key}" is not a Uint8Array (got ${type}/${ctor}). This would cause infinite recursion in fflate.`,
      );
    }
  }
  // Re-key in sorted order so insertion order (e.g. readdir order) can't
  // perturb the output; fflate preserves key iteration order.
  const sorted: Zippable = {};
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = (entries as Record<string, Zippable[string]>)[key]!;
  }
  return zipSync(sorted, { level, mtime: DETERMINISTIC_MTIME });
}

/**
 * Decompress a ZIP artifact and return sanitized file entries.
 * Filters out path traversal attempts, absolute paths, null bytes, backslashes,
 * __MACOSX metadata, and directory entries.
 * @param artifact - The ZIP file as a Uint8Array
 * @returns Map of sanitized file paths to their content
 * @throws Error if the ZIP cannot be decompressed
 */
export function unzipArtifact(artifact: Uint8Array): Record<string, Uint8Array> {
  let rawFiles: Record<string, Uint8Array>;
  try {
    rawFiles = unzipSync(artifact);
  } catch {
    throw new Error("Failed to decompress ZIP artifact");
  }

  // Sanitize: filter out path traversal, absolute paths, null bytes, backslashes, __MACOSX, and directory entries
  const files: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(rawFiles)) {
    if (
      key.split("/").some((s) => s === "..") ||
      key.startsWith("/") ||
      key.includes("\0") ||
      key.includes("\\")
    )
      continue;
    if (key.startsWith("__MACOSX/") || key.endsWith("/")) continue;
    files[key] = value;
  }

  return files;
}

// ─────────────────────────────────────────────
// Wrapper folder stripping
// ─────────────────────────────────────────────

/**
 * Detect and strip a single common wrapper folder from ZIP entries.
 * ZIPs created by macOS Finder or `zip -r folder/` wrap all files under
 * a top-level directory. This function strips that prefix so lookups
 * like `files["manifest.json"]` work regardless of how the ZIP was created.
 *
 * Only strips when ALL entries share a single first-level prefix and none
 * are at the root level. Returns the original collection unchanged otherwise.
 *
 * Accepts either a `Record<string, Uint8Array>` (default ZIP shape) or a
 * `Map<string, Uint8Array>` (sanitized bundle shape) and returns the same
 * type as the input.
 *
 * NOTE: `@appstrate/afps-runtime` keeps a local Map-only copy of this
 * algorithm to remain a zero-`@appstrate/core`-dependency package. Keep the
 * two implementations in sync. See
 * `packages/afps-runtime/src/bundle/archive-utils.ts`.
 */
export function stripWrapperPrefix(files: Record<string, Uint8Array>): Record<string, Uint8Array>;
export function stripWrapperPrefix(files: Map<string, Uint8Array>): Map<string, Uint8Array>;
export function stripWrapperPrefix(
  files: Record<string, Uint8Array> | Map<string, Uint8Array>,
): Record<string, Uint8Array> | Map<string, Uint8Array> {
  if (files instanceof Map) {
    if (files.size === 0) return files;
    const prefixes = new Set<string>();
    for (const key of files.keys()) {
      const slashIdx = key.indexOf("/");
      if (slashIdx === -1) return files; // root-level file → no stripping
      prefixes.add(key.slice(0, slashIdx));
    }
    if (prefixes.size !== 1) return files; // multiple top-level folders → ambiguous
    const prefix = `${[...prefixes][0]}/`;
    const stripped = new Map<string, Uint8Array>();
    for (const [key, value] of files) {
      stripped.set(key.slice(prefix.length), value);
    }
    return stripped;
  }

  const keys = Object.keys(files);
  if (keys.length === 0) return files;

  const prefixes = new Set<string>();
  for (const key of keys) {
    const slashIdx = key.indexOf("/");
    if (slashIdx === -1) return files; // root-level file → no stripping
    prefixes.add(key.slice(0, slashIdx));
  }

  if (prefixes.size !== 1) return files; // multiple top-level folders → ambiguous

  const prefix = `${[...prefixes][0]}/`;
  const stripped: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(files)) {
    stripped[key.slice(prefix.length)] = value;
  }
  return stripped;
}

// ─────────────────────────────────────────────
// Unified package ZIP parser — handles agent, skill, tool
// ─────────────────────────────────────────────

/** Result of parsing an AFPS package ZIP file. */
export interface ParsedPackageZip {
  /** The validated manifest from manifest.json. */
  manifest: Manifest | AgentManifest | SkillManifest | IntegrationManifest | McpServerManifest;
  /** The primary content (prompt.md for agents, SKILL.md for skills, manifest.json for integrations/mcp-servers). */
  content: string;
  /** All files in the ZIP archive (path to content). */
  files: Record<string, Uint8Array>;
  /** The detected package type. */
  type: PackageType;
  /**
   * Canonical package id — for every package type (agent/skill/integration/
   * mcp-server) this is the scoped manifest `name`. AFPS 2.0.2 (§3.4) lifted
   * the mcp-server scoped identity to the manifest root, removing the
   * previous `_meta["dev.afps/mcp-server"].name` indirection.
   */
  packageId: string;
}

/** Error thrown during package ZIP parsing with a machine-readable error code. */
export class PackageZipError extends Error {
  /**
   * @param code - Error code (e.g. "FILE_TOO_LARGE", "ZIP_INVALID", "MISSING_MANIFEST")
   * @param message - Human-readable error description
   * @param details - Optional structured error details (e.g. validation error list)
   */
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PackageZipError";
  }
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Parse and validate an AFPS package ZIP file.
 * Decompresses the ZIP, validates the manifest, and extracts the primary content
 * based on package type (prompt.md for agents, SKILL.md for skills, entrypoint for tools).
 * Includes zip bomb protection and wrapper folder stripping.
 * @param zipBuffer - The raw ZIP file as a Uint8Array
 * @param maxSize - Maximum compressed size in bytes (defaults to 10 MB)
 * @returns Parsed package with manifest, content, files, and type
 * @throws PackageZipError for size limits, invalid ZIP, missing/invalid manifest, or missing content
 * @example
 * const zip = await readFile("my-agent.afps");
 * const { manifest, content, type } = parsePackageZip(new Uint8Array(zip));
 */
export function parsePackageZip(zipBuffer: Uint8Array, maxSize?: number): ParsedPackageZip {
  const limit = maxSize ?? DEFAULT_MAX_SIZE;
  if (zipBuffer.length > limit) {
    throw new PackageZipError(
      "FILE_TOO_LARGE",
      `ZIP exceeds maximum size of ${limit / 1024 / 1024} MB`,
    );
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipArtifact(zipBuffer);
  } catch {
    throw new PackageZipError("ZIP_INVALID", "Failed to decompress ZIP artifact");
  }

  // Zip bomb protection: check total decompressed size
  const MAX_DECOMPRESSED = 50 * 1024 * 1024; // 50 MB
  const totalSize = Object.values(files).reduce((sum, buf) => sum + buf.length, 0);
  if (totalSize > MAX_DECOMPRESSED) {
    throw new PackageZipError(
      "ZIP_BOMB",
      `Decompressed size (${(totalSize / 1024 / 1024).toFixed(1)} MB) exceeds limit`,
    );
  }

  // Strip single wrapper folder if present (e.g. ZIPs from macOS Finder)
  files = stripWrapperPrefix(files);

  // Parse manifest.json
  const manifestBuffer = files["manifest.json"];
  const manifestText = manifestBuffer ? new TextDecoder().decode(manifestBuffer) : undefined;
  if (!manifestText) {
    throw new PackageZipError("MISSING_MANIFEST", "manifest.json not found in ZIP");
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestText);
  } catch {
    throw new PackageZipError("INVALID_MANIFEST", "manifest.json is not valid JSON");
  }

  const validation = validateManifest(manifestRaw);
  if (!validation.valid) {
    const detail = validation.errors.join("; ");
    throw new PackageZipError(
      "INVALID_MANIFEST",
      detail ? `Manifest validation failed: ${detail}` : "Manifest validation failed",
      validation.errors,
    );
  }

  const manifest = validation.manifest!;

  // AFPS 2.0.2 (§3.4 / §11.2) lifted mcp-server identity to the manifest root,
  // so every package type now declares its `type` at the top level.
  const type: PackageType | undefined = (manifest as { type?: PackageType }).type;

  // Extract primary content based on type
  let content: string;

  switch (type) {
    case "agent": {
      const promptRaw = files["prompt.md"];
      const promptMd = promptRaw ? new TextDecoder().decode(promptRaw) : undefined;
      if (!promptMd || promptMd.trim().length === 0) {
        throw new PackageZipError("MISSING_CONTENT", "Agent package must contain prompt.md");
      }
      content = promptMd;
      break;
    }
    case "skill": {
      const skillRaw = files["SKILL.md"];
      const skillMd = skillRaw ? new TextDecoder().decode(skillRaw) : undefined;
      if (!skillMd) {
        throw new PackageZipError("MISSING_CONTENT", "Skill package must contain SKILL.md");
      }
      const meta = extractSkillMeta(skillMd);
      if (!meta.name) {
        throw new PackageZipError(
          "INVALID_CONTENT",
          "SKILL.md must contain a 'name' in YAML frontmatter",
        );
      }
      content = skillMd;
      break;
    }
    case "integration": {
      // Integration packages (proposal §4.1.2). Phase 1.0 bundles carry
      // manifest.json as authoritative; INTEGRATION.md is an optional
      // agent-facing documentation companion. Vendored server code lives
      // under `server/` and is left untouched by this parser — the
      // runtime resolver (Phase 1.2a) consumes it directly.
      const integrationRaw = files["INTEGRATION.md"];
      content = integrationRaw ? new TextDecoder().decode(integrationRaw) : manifestText;
      break;
    }
    case "mcp-server": {
      // mcp-server packages (AFPS §3.4) are MCPB bundles — manifest.json is
      // authoritative; the server payload under `server.entry_point` is left
      // untouched for the runtime to consume directly.
      content = manifestText;
      break;
    }
    default:
      throw new PackageZipError("INVALID_MANIFEST", `Unsupported package type: "${type}"`);
  }

  // Canonical AFPS identity, type-agnostic: AFPS 2.0.2 (§3.4) lifted the
  // mcp-server scoped identity to the manifest root, so every package type
  // now stores `@scope/name` at the top-level `name`. The previous
  // `_meta["dev.afps/mcp-server"].name` fallback is gone.
  const packageId = (manifest as { name: string }).name;

  return { manifest, content, files, type: type as PackageType, packageId };
}
