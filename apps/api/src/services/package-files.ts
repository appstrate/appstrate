// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only file explorer for a package's artifact.
 *
 * Single choke point: BOTH the index route and the content route read through
 * this module, in two steps — {@link resolvePackageFileValidator} (cheap, DB
 * only) then {@link readPackageSnapshot} (the only thing that fetches bytes).
 * The split is what lets a conditional request for an immutable version be
 * answered without a download. Every future optimization (a decompressed-
 * snapshot LRU, a byte-range reader, …) lands inside this module without
 * touching a route handler — which is why the routes never call
 * `downloadPackageFiles` / `downloadVersionZip` / `getVersionForDownload`
 * directly.
 *
 * The two read modes are deliberately asymmetric:
 *
 * - **draft** — the stored ZIP is the base, but the DB draft columns
 *   (`draft_manifest` / `draft_content`) WIN over it. The editor writes the
 *   row first and re-uploads the ZIP afterwards, so the ZIP is allowed to lag;
 *   presenting its stale bytes as "the draft" would show the user something
 *   they did not write.
 * - **version** — exactly the pinned bytes, integrity-verified, no overlay. A
 *   published version is immutable by definition; a later draft edit must not
 *   be able to change what a historical version reports.
 */

import { logger } from "../lib/logger.ts";
import { notFound } from "../lib/errors.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { downloadVersionZip, unzipAndNormalize } from "./package-storage.ts";
import { getVersionForDownload } from "./package-versions.ts";
import { CONFIG_BY_TYPE, SYSTEM_STORAGE_NAMESPACE } from "./package-items/config.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import type { PackageType } from "@appstrate/core/validation";

export type PackageFileMediaKind = "text" | "binary";

/** One row of the flat file index. Wire shape — snake_case. */
export interface PackageFileEntry {
  path: string;
  size: number;
  media_kind: PackageFileMediaKind;
  /**
   * Full decoded text, or absent. NEVER a truncated prefix: a partial file
   * presented as complete is worse than no preview at all, because nothing in
   * the payload says it was cut. Absent means "fetch it from
   * `/files/content`", which always serves the whole file.
   */
  inline?: string;
}

export interface PackageFileSnapshot {
  /** Normalized (path-sanitized) file map, draft overlay already applied. */
  files: Record<string, Uint8Array>;
  /**
   * Opaque identity of this exact set of bytes, UNQUOTED and NOT itself an
   * ETag — {@link indexEtag} / {@link fileEtag} derive the per-representation
   * validators from it.
   */
  snapshotId: string;
  /** True only for an exact, non-yanked published version. */
  immutable: boolean;
}

/** The `packages` columns a snapshot read needs. */
export interface PackageFileSource {
  id: string;
  type: PackageType;
  orgId: string | null;
  source: "local" | "system";
  draftManifest: unknown;
  draftContent: string | null;
}

/**
 * Largest file we will ever decode or inline (1 MiB).
 *
 * Kept in lockstep with `PREVIEW_SIZE_LIMIT` in
 * `apps/web/src/lib/package-file-tree.ts`, which is what the SPA uses to
 * decide "preview vs. too_large". The two must agree, otherwise the UI offers
 * a preview the index will never carry an `inline` for (or refuses one it
 * already has). There is no shared constant: the value would have to cross the
 * published `@appstrate/core` boundary to be shared, which is not worth a
 * release lockstep for one number.
 */
export const INLINE_MAX_BYTES = 1_048_576;

/**
 * Ceiling on the *serialized* weight of all `inline` strings in one index
 * response. Measured on `JSON.stringify(text).length` rather than the UTF-8
 * byte count: a file of quotes and newlines inflates ~2× once escaped, and a
 * budget counted on raw bytes would let the response blow past its own limit.
 */
export const INDEX_JSON_BUDGET_BYTES = 2_097_152;

/**
 * Extensions we accept as text WITHOUT decoding. Only consulted for files too
 * large to inline — a >1 MiB blob can never be previewed, so decoding it just
 * to print a label would be pure waste. Deliberately short: this is a display
 * hint, not a MIME database.
 */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".css",
  ".html",
  ".svg",
  ".xml",
  ".csv",
  ".tsv",
  ".sql",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".log",
]);

/**
 * Lowercased extension of a path, including the leading dot. A leading-dot
 * basename with no other dot (`.gitignore`) IS its own extension — that is how
 * the interesting dotfiles are named.
 */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot);
}

/**
 * Classify by content when the file is small enough to decode, by extension
 * otherwise. A strict (`fatal`) UTF-8 decode is the honest test: it is exactly
 * the question the client asks ("can I render this as text?").
 */
function classify(
  path: string,
  bytes: Uint8Array,
  decoder: TextDecoder,
): { kind: PackageFileMediaKind; text: string | null } {
  if (bytes.byteLength > INLINE_MAX_BYTES) {
    return { kind: TEXT_EXTENSIONS.has(extensionOf(path)) ? "text" : "binary", text: null };
  }
  try {
    return { kind: "text", text: decoder.decode(bytes) };
  } catch {
    return { kind: "binary", text: null };
  }
}

/**
 * Content-addressed identity of the OVERLAID file map.
 *
 * `packages.updated_at` / `lock_version` are NOT usable here: the row is
 * written before the storage object is replaced, so a validator derived from
 * row metadata can go stale-negative (bump with no byte change) and, worse,
 * stale-positive during the window where the row moved but the ZIP has not.
 * Hashing the bytes we are about to serve is the only validator that cannot
 * disagree with the response.
 *
 * Each entry contributes `path \0 length \0 bytes`. The LENGTH term is what
 * keeps the stream unambiguous: without it, `{a:"x", b:"y"}` and `{a:"xb\0y"}`
 * serialize to the same digest.
 */
export function draftSnapshotId(files: Record<string, Uint8Array>): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const path of Object.keys(files).sort()) {
    const bytes = files[path]!;
    hasher.update(`${path}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
  }
  return `pd-${hasher.digest("hex")}`;
}

/**
 * Per-representation validators — RFC 9110 §8.8.1: an entity-tag identifies
 * ONE representation, not a resource or a snapshot.
 *
 * The index and a file are different representations of different URLs, and
 * two files of the same artifact are different representations of the SAME
 * URL (they differ by `?path=`). Giving them all one snapshot-wide tag is what
 * lets a client present a validator it obtained for file A — or for the index
 * — and be told `304` for file B, or for a path that does not exist at all.
 * So the path is folded in, and the two route families get distinct prefixes.
 */
export function indexEtag(snapshotId: string): string {
  return `"i-${snapshotId}"`;
}

export function fileEtag(snapshotId: string, path: string): string {
  // 128 bits of the path digest: this discriminates paths within one artifact,
  // it is not a security boundary (the snapshot id already pins the content).
  const pathDigest = new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 32);
  return `"f-${snapshotId}-${pathDigest}"`;
}

const MANIFEST_FILE_NAME = "manifest.json";

/**
 * Which ZIP entry `packages.draft_content` is the authoritative copy of, per
 * type. Mirrors the extraction switch in `parsePackageZip`
 * (`packages/core/src/zip.ts:375-395`), which is what populates the column.
 * `null` = the column is a redundant copy of the manifest, not a file of its
 * own, and must not be materialized as a phantom entry.
 */
const DRAFT_CONTENT_FILE: Record<PackageType, string | null> = {
  agent: "prompt.md",
  skill: "SKILL.md",
  integration: "INTEGRATION.md",
  "mcp-server": null,
};

/**
 * Apply the DB-authoritative draft columns on top of the stored ZIP, in place.
 * Exported so the per-type overlay matrix can be asserted without a database
 * or object storage — it is the part of the draft path most likely to drift
 * away from `parsePackageZip`.
 */
export function applyDraftOverlay(files: Record<string, Uint8Array>, pkg: PackageFileSource): void {
  const encoder = new TextEncoder();

  const target = DRAFT_CONTENT_FILE[pkg.type];
  if (target !== null && pkg.draftContent !== null) {
    // INTEGRATION.md is an OPTIONAL companion: when a bundle ships without
    // one, `zip.ts:391` falls back to storing the manifest text in
    // `draft_content`. Overlaying that would invent an INTEGRATION.md the
    // package does not have — so the overlay only applies on top of an entry
    // that already exists. agent/skill have no such fallback: their column is
    // genuinely their only file, and a freshly created package with no stored
    // ZIP must still list it.
    const optionalCompanion = pkg.type === "integration";
    if (!optionalCompanion || Object.hasOwn(files, target)) {
      files[target] = encoder.encode(pkg.draftContent);
    }
  }

  if (pkg.draftManifest !== null && pkg.draftManifest !== undefined) {
    files[MANIFEST_FILE_NAME] = encoder.encode(JSON.stringify(pkg.draftManifest, null, 2));
  }
}

/**
 * What a read WILL produce, resolved without touching object storage.
 *
 * A published version is content-addressed by the `integrity` column, so its
 * snapshot identity is a plain DB read — which means a conditional request for
 * a version can be answered for the cost of one query, with no download and no
 * decompression. The draft has no such shortcut: its identity is derived from
 * the bytes themselves (see {@link draftSnapshotId}), so `snapshotId` is
 * `null` and the caller has to read before it can compare.
 */
export type PackageFileValidator =
  | { kind: "draft"; snapshotId: null; immutable: false; yanked: false }
  | {
      kind: "version";
      snapshotId: string;
      immutable: boolean;
      yanked: boolean;
      version: string;
      integrity: string;
    };

/**
 * Resolve the validator for a read. Cheap: at most one DB query, never a
 * storage GET.
 *
 * @param version - Omitted or `"draft"` selects the live draft; anything else
 *   is resolved as a version spec (exact / dist-tag / semver range).
 * @throws 404 when the requested version does not exist.
 */
export async function resolvePackageFileValidator(
  pkg: PackageFileSource,
  version?: string,
): Promise<PackageFileValidator> {
  if (!version || version === VERSION_SELECTOR_DRAFT) {
    return { kind: "draft", snapshotId: null, immutable: false, yanked: false };
  }
  const ver = await getVersionForDownload(pkg.id, version);
  if (!ver) throw notFound("Version not found");

  // `immutable` is a promise that THIS URL will never mean anything else, so
  // it can only be made when the caller pinned the exact version. A dist-tag
  // or a semver range is a MOVING target — `?version=latest` starts meaning
  // 1.1.0 the moment it is published, and a year-long `immutable` would stop
  // the client from ever finding out. A yank is the same problem in reverse:
  // a client holding an immutable copy could never learn it was withdrawn.
  // Both still get the honest content ETag, just with revalidation.
  const exact = version === ver.version;
  return {
    kind: "version",
    snapshotId: `pv-${ver.integrity}`,
    immutable: exact && !ver.yanked,
    yanked: ver.yanked,
    version: ver.version,
    integrity: ver.integrity,
  };
}

/**
 * Read a package's files as they should be presented to the explorer.
 *
 * Takes an already-resolved {@link PackageFileValidator} so the version
 * lookup is never paid twice, and so a conditional request that never gets
 * here provably never touched storage. This is the ONLY function that fetches
 * package bytes for the explorer, and the only emitter of the
 * `"Package file snapshot read"` log line.
 *
 * @throws 404 when a version's artifact is missing from storage. A missing
 *   DRAFT artifact is not an error — a freshly created package has no ZIP yet
 *   and must still list its DB-backed files.
 */
export async function readPackageSnapshot(
  pkg: PackageFileSource,
  validator: PackageFileValidator,
): Promise<PackageFileSnapshot> {
  const startedAt = performance.now();

  let files: Record<string, Uint8Array>;
  let snapshotId: string;

  if (validator.kind === "draft") {
    // Derive the namespace from the column that actually decides it:
    // `packageItemOwnerNamespace` keys off `orgId`, NOT `source`. Reading
    // `source` instead would send an (impossible, but silent) orgId-null local
    // package to the org path and hand back an empty file list rather than an
    // error.
    const ownerNamespace = pkg.orgId ?? SYSTEM_STORAGE_NAMESPACE;
    const stored = await downloadPackageFiles(
      CONFIG_BY_TYPE[pkg.type].storageFolder,
      ownerNamespace,
      pkg.id,
      undefined,
      pkg.orgId === null ? "system" : "org",
    );
    files = stored ?? {};
    applyDraftOverlay(files, pkg);
    snapshotId = draftSnapshotId(files);
  } else {
    // Integrity is passed on purpose: this is the same SRI gate the download
    // route applies. Reading a version through a path that skips it would make
    // the explorer the one place tampering goes unnoticed.
    const zip = await downloadVersionZip(pkg.id, validator.version, validator.integrity);
    if (!zip) throw notFound("Artifact not found in storage");
    files = unzipAndNormalize(zip);
    snapshotId = validator.snapshotId;
  }

  let decompressedBytes = 0;
  let fileCount = 0;
  for (const key of Object.keys(files)) {
    decompressedBytes += files[key]!.byteLength;
    fileCount++;
  }

  // The evidence a later "should we cache snapshots?" decision will be made on
  // (plan §7 defers the LRU). Without these numbers the answer is a guess.
  logger.info("Package file snapshot read", {
    packageId: pkg.id,
    version: validator.kind === "version" ? validator.version : VERSION_SELECTOR_DRAFT,
    fileCount,
    decompressedBytes,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return { files, snapshotId, immutable: validator.immutable };
}

/**
 * Flatten a snapshot into the wire index.
 *
 * Entries are emitted in sorted path order so the same snapshot always yields
 * the same index — which is what makes the inline budget deterministic
 * (otherwise "which files got a preview" would drift with map iteration
 * order). Directories are NOT synthesized: the index is a flat list of real
 * files and the client derives the tree from the paths.
 */
export function buildFileIndex(snapshot: PackageFileSnapshot): PackageFileEntry[] {
  // `ignoreBOM: true` = do NOT strip a leading U+FEFF. The default silently
  // drops it, which would make `inline` neither the full text nor a faithful
  // rendering of `size` bytes — a client writing the preview back would lose
  // the BOM.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let remaining = INDEX_JSON_BUDGET_BYTES;
  const entries: PackageFileEntry[] = [];

  for (const path of Object.keys(snapshot.files).sort()) {
    const bytes = snapshot.files[path]!;
    const { kind, text } = classify(path, bytes, decoder);
    const entry: PackageFileEntry = { path, size: bytes.byteLength, media_kind: kind };
    // `remaining > 0` short-circuits the stringify itself, not just its
    // result: once the budget is spent, every remaining text file would
    // otherwise allocate a full escaped copy only to have it discarded.
    if (text !== null && remaining > 0) {
      const cost = JSON.stringify(text).length;
      if (cost <= remaining) {
        entry.inline = text;
        remaining -= cost;
      }
      // Over budget: the entry is still listed and still fetchable via
      // `/files/content`. Only the free preview is dropped.
    }
    entries.push(entry);
  }

  return entries;
}
