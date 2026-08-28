// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { zipSync, type Zippable } from "fflate";
import {
  validateManifest,
  type Manifest,
  type AgentManifest,
  type SkillManifest,
  type PackageType,
  type IntegrationManifest,
  type McpServerManifest,
  type RetiredRuntimeToolsPolicy,
} from "./validation.ts";
import {
  checkCompanionFiles,
  companionFilesFromRecord,
} from "@appstrate/afps-shared/companion-files";
import {
  unzipBounded,
  DecompressionLimitError,
  type BoundedUnzipLimits,
} from "@appstrate/afps-shared/unzip-bounded";
import { stripWrapperPrefix } from "@appstrate/afps-shared/archive-prefix";
import { PACKAGE_CONTENT_FILE } from "./package-files.ts";
import { getErrorMessage } from "./errors.ts";

export type { Zippable };
export { unzipBounded, DecompressionLimitError };
export type { BoundedUnzipLimits };

/**
 * Fixed modification time stamped on every ZIP entry. fflate defaults each
 * entry's mtime to the current clock, which makes archive bytes — and thus
 * their integrity hash — change on every build even when the contents are
 * identical. ZIP mtimes are never read back (`unzipArtifact` discards them),
 * so pinning a constant costs nothing and makes the output reproducible.
 * Reproducibility is what lets the system-package loader treat an integrity
 * drift as a genuine content change (forgotten version bump) rather than
 * rebuild noise.
 *
 * Built from LOCAL date components on purpose: the DOS time field in a ZIP
 * has no timezone, and fflate encodes it via the Date's *local* getters
 * (`getFullYear`/`getHours`/…). A UTC instant (`…T00:00:00Z`) would therefore
 * encode different bytes depending on the builder's timezone — a dev in EDT
 * and CI in UTC would produce non-identical archives, breaking the
 * `build:system-packages --check` byte comparison. `new Date(2020, 0, 1)`
 * reads back as 2020-01-01 00:00:00 under every timezone. Any constant ≥ 1980
 * works (DOS time epoch).
 */
const DETERMINISTIC_MTIME = new Date(2020, 0, 1, 0, 0, 0, 0);

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

/** Default decompressed budget for `unzipArtifact` when a caller passes none. */
const DEFAULT_MAX_DECOMPRESSED = 200 * 1024 * 1024; // 200 MB
const DEFAULT_MAX_FILES = 10_000;

/**
 * Decompress a ZIP artifact and return sanitized file entries.
 * Filters out path traversal attempts, absolute paths, null bytes, backslashes,
 * __MACOSX metadata, and directory entries.
 *
 * Decompression is STREAMING and memory-bounded (see `unzipBounded`): the
 * cumulative decompressed budget is enforced mid-inflate, so a zip bomb aborts
 * before it can materialize — unlike the previous `unzipSync` + post-hoc sum,
 * which allocated the whole archive first.
 *
 * @param artifact - The ZIP file as a Uint8Array
 * @param opts.maxDecompressedBytes - cumulative decompressed cap (default 200 MB)
 * @param opts.maxFiles - entry-count cap (default 10 000)
 * @returns Map of sanitized file paths to their content
 * @throws DecompressionLimitError when a budget is crossed
 * @throws Error if the ZIP cannot be decompressed
 */
export function unzipArtifact(
  artifact: Uint8Array,
  opts?: { maxDecompressedBytes?: number; maxFiles?: number },
): Record<string, Uint8Array> {
  let rawFiles: Record<string, Uint8Array>;
  try {
    rawFiles = unzipBounded(artifact, {
      maxDecompressedBytes: opts?.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED,
      maxFiles: opts?.maxFiles ?? DEFAULT_MAX_FILES,
    });
  } catch (err) {
    if (err instanceof DecompressionLimitError) throw err; // surface bomb/limit verbatim
    // Both halves matter: the message names the operation, and fflate's own
    // message names what was wrong with the bytes (truncated central
    // directory, unsupported compression method, …). Inline it AND attach the
    // error — nothing here reads a `cause` chain today (see the API error
    // handler), so the message is what actually reaches a human.
    throw new Error(`Failed to decompress ZIP artifact: ${getErrorMessage(err)}`, { cause: err });
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
 * Detect and strip a single common wrapper folder from ZIP entries — re-exported
 * verbatim from the zero-dependency `@appstrate/afps-shared` package, so the
 * `@appstrate/core/zip` public surface is unchanged (both overloads, `Record`
 * and `Map`, and the identity return when there is nothing to strip).
 *
 * The implementation lives in `@appstrate/afps-shared/archive-prefix` because
 * `@appstrate/afps-runtime` strips the same prefix on its `.afps` ingestion
 * path and must NOT take a runtime dependency on `@appstrate/core`. Before this
 * move it kept a hand-copy of the `Map` branch under a comment asking a human
 * to keep the two in sync, with no parity test policing it — the same
 * arrangement that let the media-type set drift three times before it moved to
 * `@appstrate/afps-shared/mime`.
 *
 * See that module for the full rule, including why an entry at the root level
 * or a second top-level folder means "strip nothing".
 */
export { stripWrapperPrefix };

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
   * mcp-server) this is the scoped manifest `name`. AFPS (§3.4) lifted
   * the mcp-server scoped identity to the manifest root, removing the
   * previous `_meta["dev.afps/mcp-server"].name` indirection.
   */
  packageId: string;
  /**
   * `runtime_tools` ids the platform retired, stripped from {@link manifest}
   * while parsing. Always `[]` unless the caller passed
   * `retiredRuntimeTools: "drop"` — the drop is silent by construction, so a
   * caller that opted into it MUST surface this (install warning, log) rather
   * than let the capability loss disappear.
   */
  droppedRuntimeTools: string[];
}

/** Error thrown during package ZIP parsing with a machine-readable error code. */
export class PackageZipError extends Error {
  /**
   * @param code - Error code (e.g. "FILE_TOO_LARGE", "ZIP_INVALID", "MISSING_MANIFEST")
   * @param message - Human-readable error description
   * @param details - Optional structured error details (e.g. validation error list)
   * @param options - Standard `ErrorOptions`; pass `{ cause }` when raising this
   *   from a `catch` so the underlying decoder/IO error is not discarded.
   *   `preserve-caught-error` cannot see custom classes, so this is on us.
   */
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PackageZipError";
  }
}

/** Canonical compressed-size ceiling for one author-supplied package archive. */
export const PACKAGE_ZIP_MAX_COMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Canonical DECOMPRESSED ceiling for one package archive — the amplification
 * budget that pairs with {@link PACKAGE_ZIP_MAX_COMPRESSED_BYTES}.
 *
 * Exported because the ceiling must be the SAME number on the way in and on the
 * way back out. It used to be a function-local constant in `parsePackageZip`,
 * so every path that re-read a stored artifact silently inherited
 * `unzipArtifact`'s far looser 200 MB default and re-opened the amplification
 * the import gate had just closed. One name, one value, both boundaries.
 */
export const PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB

/** Options for {@link parsePackageZip}. */
export interface ParsePackageZipOptions {
  /** Maximum compressed size in bytes. Defaults to 10 MB. */
  maxSize?: number;
  /**
   * How the embedded manifest's retired `runtime_tools` ids are treated —
   * forwarded verbatim to `validateManifest`. Defaults to `"reject"`, because
   * a ZIP is author input unless the caller knows otherwise.
   *
   * Pass `"drop"` ONLY when the archive is content the platform already holds
   * and cannot repair in place (a re-import of a published, integrity-checked
   * artifact). See the doctrine on
   * {@link import("./validation.ts").RetiredRuntimeToolsPolicy}.
   */
  retiredRuntimeTools?: RetiredRuntimeToolsPolicy;
}

/**
 * Parse and validate an AFPS package ZIP file.
 * Decompresses the ZIP, validates the manifest, and extracts the primary content
 * based on package type (prompt.md for agents, SKILL.md for skills, entrypoint for tools).
 * Includes zip bomb protection and wrapper folder stripping.
 * @param zipBuffer - The raw ZIP file as a Uint8Array
 * @param options - {@link ParsePackageZipOptions}
 * @returns Parsed package with manifest, content, files, type, and any dropped runtime-tool ids
 * @throws PackageZipError for size limits, invalid ZIP, missing/invalid manifest, or missing content
 * @throws TypeError when `options` is a number — see the guard in the body
 * @example
 * const zip = await readFile("my-agent.afps");
 * const { manifest, content, type } = parsePackageZip(new Uint8Array(zip));
 */
export function parsePackageZip(
  zipBuffer: Uint8Array,
  options?: ParsePackageZipOptions,
): ParsedPackageZip {
  // The signature says `options` cannot be a number, so an in-tree call site
  // that passes one fails to compile. This runtime check outlives that type on
  // purpose: `@appstrate/core` is PUBLISHED, and a published consumer can still
  // pass the retired positional `maxSize` with no compiler in the way. Be exact
  // about who that is — this package ships RAW TypeScript (`"./zip":
  // "./src/zip.ts"`, `files: ["src", …]`, `engines.bun`, no build step), so a
  // plain-JS Node consumer of this subpath cannot exist at all. The reachable
  // caller is narrower: a Bun consumer that never runs `tsc` — its own `check`
  // is lint-only, or the call is in a `.js`/`.mjs` file, or it types the
  // argument `any`. Bun executes the `.ts` and erases the type either way.
  // Hence the cast — the check has to test a shape the type has already ruled
  // out.
  //
  // Deleting the check instead would not restore the old behaviour, it would
  // HIDE it: a number falls through `options ?? {}`, `opts.maxSize` reads
  // `undefined`, and the default ceiling silently replaces the limit the caller
  // asked for. `docs/NO_TRANSITIONAL_CODE.md` step 5 — a retired form that can
  // still arrive from outside must fail loudly, never work.
  //
  // A `TypeError` and not a `PackageZipError`: nothing is wrong with the
  // archive, the call is wrong. `PackageZipError` is what `routes/packages.ts`
  // renders into the 400 an uploader reads, and that would blame them for a bug
  // in the calling code.
  if (typeof (options as unknown) === "number") {
    throw new TypeError(
      `parsePackageZip(zip, ${String(options)}): the bare-number \`maxSize\` argument is retired. ` +
        `Pass a ParsePackageZipOptions object instead: parsePackageZip(zip, { maxSize: ${String(options)} }).`, // canonical-casing-exempt
    );
  }
  const opts: ParsePackageZipOptions = options ?? {};
  const limit = opts.maxSize ?? PACKAGE_ZIP_MAX_COMPRESSED_BYTES;
  if (zipBuffer.length > limit) {
    throw new PackageZipError(
      "FILE_TOO_LARGE",
      `ZIP exceeds maximum size of ${limit / 1024 / 1024} MB`,
    );
  }

  // Zip bomb protection is now enforced DURING decompression (streaming budget)
  // rather than after full materialization — a bomb aborts mid-inflate.
  let files: Record<string, Uint8Array>;
  try {
    files = unzipArtifact(zipBuffer, {
      maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
    });
  } catch (err) {
    if (err instanceof DecompressionLimitError) {
      // A resource-exhaustion verdict → ZIP_BOMB; a structural one → ZIP_INVALID.
      if (err.reason === "corrupt-archive") {
        // Same rule as the generic branch below, and for the same reason: this
        // is the verdict that means "the archive is structurally broken", the
        // one an uploader can actually act on, and `DecompressionLimitError`'s
        // detail is the only text that says HOW ("not a ZIP archive",
        // "invalid distance", "unexpected EOF"). A fixed string collapsed all
        // of them into one shrug.
        //
        // Safe to surface: for `corrupt-archive` the detail is either a
        // literal of ours or the fflate decoder's own static sentence. It
        // carries no request context and nothing credential-adjacent — the
        // only uploader-controlled string `DecompressionLimitError` ever
        // interpolates is an archive entry name, and that belongs to
        // `file-too-large`, which lands on the ZIP_BOMB branch below.
        throw new PackageZipError("ZIP_INVALID", getErrorMessage(err), undefined, { cause: err });
      }
      // Deliberately fixed. The budget verdicts already name themselves
      // completely — there is no decoder sentence to add — and their detail
      // CAN be an archive entry name (`file-too-large` passes `file.name`),
      // i.e. attacker-chosen text that would be echoed into a 400.
      throw new PackageZipError("ZIP_BOMB", "Decompressed size exceeds limit", undefined, {
        cause: err,
      });
    }
    // `unzipArtifact` above already names the operation AND inlines the
    // decoder's own message; re-wrapping with a fixed string would discard
    // that on the one path where it reaches a human — `routes/packages.ts`
    // renders `PackageZipError.message` into the 400 the uploader sees, so
    // "invalid zip data" vs "unexpected EOF" is the difference between a
    // fixable report and a shrug.
    throw new PackageZipError("ZIP_INVALID", getErrorMessage(err), undefined, { cause: err });
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
  } catch (err) {
    // `PackageZipError` gained its `ErrorOptions` parameter for exactly this:
    // "is not valid JSON" is the same sentence for a truncated file, a BOM and
    // a trailing comma. The SyntaxError's offset is what tells them apart.
    throw new PackageZipError("INVALID_MANIFEST", "manifest.json is not valid JSON", undefined, {
      cause: err,
    });
  }

  const validation = validateManifest(manifestRaw, {
    retiredRuntimeTools: opts.retiredRuntimeTools ?? "reject",
  });
  if (!validation.valid) {
    const detail = validation.errors.join("; ");
    throw new PackageZipError(
      "INVALID_MANIFEST",
      detail ? `Manifest validation failed: ${detail}` : "Manifest validation failed",
      validation.errors,
    );
  }

  const manifest = validation.manifest!;

  // AFPS (§3.4 / §11.2) lifted mcp-server identity to the manifest root,
  // so every package type now declares its `type` at the top level.
  const type: PackageType | undefined = (manifest as { type?: PackageType }).type;

  // Enforce §3.3 / §3.4 companion-file invariants via the shared helper so
  // the platform import path and the runtime bundle loader reject the same
  // inputs. The helper covers: agent prompt.md non-empty, skill SKILL.md +
  // frontmatter name, mcp-server server.entry_point payload present.
  const violation = checkCompanionFiles(
    manifest as { type?: unknown; server?: unknown } & Record<string, unknown>,
    companionFilesFromRecord(files),
  );
  if (violation) {
    const code =
      violation.reason === "SKILL_MISSING_FRONTMATTER_NAME" ? "INVALID_CONTENT" : "MISSING_CONTENT";
    throw new PackageZipError(code, violation.message);
  }

  // Extract primary content based on type. Companion-file presence is
  // already guaranteed above; the switch below only reads the bytes the
  // caller wants surfaced as `content`.
  //
  // WHICH entry that is per type is not decided here: it comes from
  // `PACKAGE_CONTENT_FILE`, because the platform's file explorer overlays the
  // stored `content` back onto the same entry and the two must not disagree.
  // What stays here is the per-type handling of its ABSENCE.
  let content: string;

  switch (type) {
    case "agent":
    case "skill": {
      content = new TextDecoder().decode(files[PACKAGE_CONTENT_FILE[type]!]!);
      break;
    }
    case "integration": {
      // Integration packages (proposal §4.1.2). Phase 1.0 bundles carry
      // manifest.json as authoritative; INTEGRATION.md is an optional
      // agent-facing documentation companion. Vendored server code lives
      // under `server/` and is left untouched by this parser — the
      // runtime resolver (Phase 1.2a) consumes it directly.
      const integrationRaw = files[PACKAGE_CONTENT_FILE.integration!];
      content = integrationRaw ? new TextDecoder().decode(integrationRaw) : manifestText;
      break;
    }
    case "mcp-server": {
      // mcp-server packages (AFPS §3.4) are MCPB bundles — manifest.json is
      // authoritative (hence the `null` entry in `PACKAGE_CONTENT_FILE`); the
      // server payload under `server.entry_point` is left untouched for the
      // runtime to consume directly.
      content = manifestText;
      break;
    }
    default:
      throw new PackageZipError("INVALID_MANIFEST", `Unsupported package type: "${type}"`);
  }

  // Canonical AFPS identity, type-agnostic: AFPS (§3.4) lifted the
  // mcp-server scoped identity to the manifest root, so every package type
  // now stores `@scope/name` at the top-level `name`. The previous
  // `_meta["dev.afps/mcp-server"].name` fallback is gone.
  const packageId = (manifest as { name: string }).name;

  return {
    manifest,
    content,
    files,
    type: type as PackageType,
    packageId,
    droppedRuntimeTools: validation.droppedRuntimeTools,
  };
}
