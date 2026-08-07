// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only file explorer for a package's artifact.
 *
 * Single choke point FOR THE FILE-EXPLORER ROUTES: both of them (the index and
 * the content route) read through this module, in two steps —
 * {@link resolvePackageFileValidator} (cheap, DB only) then
 * {@link readPackageSnapshot} (the only thing that fetches bytes). The split is
 * what lets a conditional request for an exact version be answered from one DB
 * read, with no download. Every future optimization (a decompressed-snapshot
 * LRU, a byte-range reader, …) lands inside this module without touching a
 * route handler — which is why those two handlers never call
 * `downloadPackageFiles` / `downloadVersionZip` / `getVersionForDownload`
 * themselves. The claim is scoped to them: the download, publish and version
 * routes in `routes/packages.ts` call all three directly, and are not served
 * by this module.
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
import { downloadVersionZip } from "./package-storage.ts";
import { unzipPackageArchive } from "./package-archive.ts";
import { getVersionForDownload } from "./package-versions.ts";
import { CONFIG_BY_TYPE, SYSTEM_STORAGE_NAMESPACE } from "./package-items/config.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import {
  PACKAGE_CONTENT_ENTRY,
  PACKAGE_FILE_INLINE_MAX_BYTES,
} from "@appstrate/core/package-files";
import { isManifestTextFallback } from "../lib/manifest-utils.ts";
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
}

/** The `packages` columns a snapshot read needs. */
export interface PackageFileSource {
  id: string;
  type: PackageType;
  orgId: string | null;
  draftManifest: unknown;
  draftContent: string | null;
}

/**
 * Ceiling on the *serialized* weight of all `inline` strings in one index
 * response, counted in UTF-8 BYTES OF RESPONSE BODY — see
 * {@link serializedInlineBytes}. Escaping is part of the weight: a file of
 * quotes and newlines inflates ~2× once serialized, and a budget counted on
 * raw file size alone would let the response blow past its own limit.
 */
export const INDEX_JSON_BUDGET_BYTES = 2_097_152;

/**
 * How many bytes of response body `text` will occupy once serialized as a JSON
 * string — escaping and the two delimiting quotes included.
 *
 * `JSON.stringify(text).length` is NOT that number: `String.length` counts
 * UTF-16 code units, not bytes. A CJK character is 1 unit but 3 UTF-8 bytes and
 * an astral emoji is 2 units but 4 bytes, so that measure undercounts by up to
 * 3×. Measured on this exact path, five files of 1,048,575 bytes of `中` each
 * scored 349,527 — all five inlined, for a 5,242,875-byte response under a
 * "2 MiB" budget.
 *
 * Re-encoding the serialized string (`new TextEncoder().encode(json)`) would
 * answer exactly, but at the cost of a second full copy of every file in
 * memory. It is not needed, because `JSON.stringify` only ever ADDS ASCII: it
 * emits the two quotes and rewrites `"`, `\` and the C0 controls — every one of
 * them a single-byte ASCII character — into `\"` / `\\` / `\n` / `\uXXXX`,
 * which are pure ASCII too. It never drops, reorders or re-encodes a character
 * (U+2028/U+2029 are notably NOT escaped). So each UTF-16 unit the
 * serialization adds is worth exactly one UTF-8 byte, and the length delta
 * alone converts the raw byte count into the serialized one.
 *
 * The two inputs cannot disagree: `bytes` is the file's exact UTF-8 length and
 * `text` is its strict-`fatal` decode of those same bytes. The one input for
 * which `JSON.stringify` escapes a NON-ASCII unit — a lone surrogate, emitted
 * as `\uD800` — cannot reach here: it would have thrown in {@link classify} and
 * been called binary.
 *
 * Verified by exhaustive comparison against `TextEncoder().encode(...)` over
 * every Unicode code point (surrogates excluded) plus a randomized sweep of
 * mixed control/quote/multi-byte/astral strings.
 */
function serializedInlineBytes(text: string, bytes: Uint8Array): number {
  return bytes.byteLength + (JSON.stringify(text).length - text.length);
}

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
  if (bytes.byteLength > PACKAGE_FILE_INLINE_MAX_BYTES) {
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
 * Apply the DB-authoritative draft columns on top of the stored ZIP, in place.
 * Exported so the per-type overlay matrix can be asserted without a database
 * or object storage — it is the part of the draft path most likely to drift
 * away from `parsePackageZip`.
 *
 * Which entry `packages.draft_content` is the authoritative copy of — and
 * whether that entry is mandatory — both come from `PACKAGE_CONTENT_ENTRY`:
 * this overlay is the exact inverse of the extraction that populates the
 * column, so the two read one declaration instead of mirroring each other's
 * switch. `null` there = the column is a redundant copy of the manifest, not a
 * file of its own, and must not be materialized as a phantom entry.
 */
export function applyDraftOverlay(files: Record<string, Uint8Array>, pkg: PackageFileSource): void {
  const encoder = new TextEncoder();

  const entry = PACKAGE_CONTENT_ENTRY[pkg.type];
  if (entry !== null && pkg.draftContent !== null) {
    // An OPTIONAL entry (`required: false`, i.e. INTEGRATION.md) is overlaid
    // only on top of one that already exists AND only when the column actually
    // holds it: when a bundle ships without one, `parsePackageZip` falls back
    // to storing the manifest text in `draft_content`. Materializing that with
    // no file underneath would invent a companion the package does not have —
    // and overlaying it on top of a REAL `INTEGRATION.md` (which every write
    // path that produces a manifest copy used to leave behind) serves the
    // package's own manifest UNDER THE NAME OF ITS DOCUMENTATION, the entry
    // the explorer pre-selects. The stored file is intact in both cases, so
    // declining the overlay shows the truth rather than a stale guess.
    //
    // A REQUIRED entry has no such fallback — its column is genuinely its only
    // file, a freshly created package with no stored ZIP must still list it,
    // and a JSON-shaped `prompt.md` must never be mistaken for a manifest.
    const isFallback = !entry.required && isManifestTextFallback(pkg.draftContent);
    if (!isFallback && (entry.required || Object.hasOwn(files, entry.path))) {
      files[entry.path] = encoder.encode(pkg.draftContent);
    }
  }

  if (pkg.draftManifest !== null && pkg.draftManifest !== undefined) {
    files[MANIFEST_FILE_NAME] = encoder.encode(JSON.stringify(pkg.draftManifest, null, 2));
  }
}

/**
 * What to persist into `packages.draft_content` on a write whose `content` is
 * a copy of the MANIFEST rather than the type's content file — the guard on
 * the inverse of {@link applyDraftOverlay}.
 *
 * The package editors and the version-restore route both feed one `content`
 * field. For `agent` / `skill` that field IS `prompt.md` / `SKILL.md`, so it
 * simply wins. For `integration` it is the manifest JSON (the editor authors a
 * manifest and has no `INTEGRATION.md` field at all — see
 * `apps/web/src/pages/package-editor.tsx`), while the COLUMN holds the
 * optional `INTEGRATION.md`. Writing one into the other destroyed the doc: the
 * integration stopped contributing its agent-facing documentation to every
 * agent's platform prompt (`fetchIntegrationPromptDocs`), and the file
 * explorer began serving manifest JSON under the name `INTEGRATION.md`.
 *
 * So a manifest-shaped write REFRESHES the manifest-text fallback — an
 * integration that legitimately ships no doc must keep a current one — and is
 * declined over a column that holds the real thing. Nothing else can author
 * that doc through this path, so "keep what is there" is the only correct
 * answer; a genuine replacement arrives through import
 * (`parsePackageZip` → `draft_content`), which is unaffected.
 *
 * Storage is a separate sink and is deliberately NOT routed through here: the
 * editor's manifest JSON still belongs in the integration's `manifest.json`.
 */
export function resolveDraftContent(
  type: PackageType,
  stored: string | null,
  incoming: string,
): string {
  const entry = PACKAGE_CONTENT_ENTRY[type];
  // REQUIRED (prompt.md / SKILL.md): `incoming` IS that file. `null`
  // (mcp-server): the column is a redundant manifest copy by definition. In
  // neither case can the column mean two things, so neither is guarded.
  if (entry === null || entry.required) return incoming;
  if (!stored) return incoming;
  return isManifestTextFallback(stored) ? incoming : stored;
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
  | { kind: "draft"; snapshotId: null; yanked: false }
  | {
      kind: "version";
      snapshotId: string;
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
    return { kind: "draft", snapshotId: null, yanked: false };
  }
  const ver = await getVersionForDownload(pkg.id, version);
  if (!ver) throw notFound("Version not found");

  return {
    kind: "version",
    snapshotId: `pv-${ver.integrity}`,
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
    files = unzipPackageArchive(zip);
    snapshotId = validator.snapshotId;
  }

  let snapshotBytes = 0;
  let fileCount = 0;
  for (const key of Object.keys(files)) {
    snapshotBytes += files[key]!.byteLength;
    fileCount++;
  }

  // The evidence a later "should we cache snapshots?" decision will be made on
  // (plan §7 defers the LRU). Without these numbers the answer is a guess.
  logger.info("Package file snapshot read", {
    packageId: pkg.id,
    version: validator.kind === "version" ? validator.version : VERSION_SELECTOR_DRAFT,
    fileCount,
    snapshotBytes,
  });

  return { files, snapshotId };
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
      const cost = serializedInlineBytes(text, bytes);
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
