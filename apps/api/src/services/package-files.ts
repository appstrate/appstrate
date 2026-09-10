// SPDX-License-Identifier: Apache-2.0

/**
 * A package's draft file tree — the reads that present it, and the one write
 * that changes it ({@link mutatePackageDraftFiles}).
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
 *
 * The write half is one function on purpose. A draft tree lives in two stores
 * that no transaction spans — the `packages` row and the ZIP object — so every
 * writer has to serialize against the other writers, re-read, validate and
 * persist in the same order, or the two halves drift. There is one such
 * sequence, {@link mutatePackageDraftFiles}, and every EDITING route takes it.
 * Its header names the four writers that do not, and why each one is out.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { conflict, notFound, preconditionFailed } from "../lib/errors.ts";
import { downloadPackageFiles, uploadPackageFiles } from "./package-items/storage.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { unzipPackageArchive } from "./package-archive.ts";
import { getVersionForDownload } from "./package-versions.ts";
import {
  CONFIG_BY_TYPE,
  SYSTEM_STORAGE_NAMESPACE,
  assertArchiveContentConforms,
} from "./package-items/config.ts";
import { updateOrgItem } from "./package-items/crud.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import {
  PACKAGE_CONTENT_ENTRY,
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
} from "@appstrate/core/package-files";
import {
  ARCHIVE_MAX_FILES,
  PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
  isSafeArchivePath,
} from "@appstrate/core/zip";
import { decodeSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { asRecord } from "@appstrate/core/safe-json";
import { isManifestTextFallback } from "../lib/manifest-utils.ts";
import type { PackageType } from "@appstrate/core/validation";

type PackageFileMediaKind = "text" | "binary";

/** One row of the flat file index. Wire shape — snake_case. */
interface PackageFileEntry {
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
    // An EMPTY column counts as "no authoritative copy" for the same reason
    // and is listed explicitly, because `isManifestTextFallback` short-circuits
    // on a falsy input and would otherwise call `""` the real doc: overlaying
    // it truncated a genuine `INTEGRATION.md` to a 0-byte file in the explorer
    // while `?version=…` on the same package still served it. `forkPackage`
    // produced exactly that column until it started reading
    // `PACKAGE_CONTENT_ENTRY`; the guard stays regardless, since any future
    // writer that leaves the column empty must degrade to the stored bytes
    // rather than erase them.
    //
    // A REQUIRED entry has no such fallback — its column is genuinely its only
    // file, a freshly created package with no stored ZIP must still list it,
    // and a JSON-shaped `prompt.md` must never be mistaken for a manifest. An
    // empty one there is an empty prompt, which is the truth.
    const isFallback =
      !entry.required && (!pkg.draftContent || isManifestTextFallback(pkg.draftContent));
    if (!isFallback && (entry.required || Object.hasOwn(files, entry.path))) {
      files[entry.path] = encoder.encode(pkg.draftContent);
    }
  }

  if (pkg.draftManifest !== null && pkg.draftManifest !== undefined) {
    files[PACKAGE_MANIFEST_FILE] = encoder.encode(JSON.stringify(pkg.draftManifest, null, 2));
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
 * ## INCOMING's shape is the FIRST question, and it is what gates the guard
 *
 * The guard only engages when the value being WRITTEN is manifest-shaped,
 * because that is the shape the platform generates and can therefore read
 * unambiguously: a manifest-shaped `incoming` can only have come from the
 * manifest editor's `toWireBody`, which has no `INTEGRATION.md` field to have
 * produced it from. A markdown-shaped `incoming` is a caller sending the doc.
 *
 * Gating on STORED's shape ALONE made the field WRITE-ONCE, and silently: a
 * non-SPA client (curl, CI, an agent through the MCP module) that PUT a new
 * `INTEGRATION.md` over a column already holding one got `200` and its
 * markdown dropped on the floor — nowhere at all, since this type's storage
 * sink is `manifest.json`. The same request DID land whenever the column
 * happened to hold the manifest fallback, so the field wrote exactly once per
 * package with no way for the client to tell which mode it was in.
 *
 * So a manifest-shaped write REFRESHES the manifest-text fallback — an
 * integration that legitimately ships no doc must keep a current one — and is
 * declined ONLY over a column that holds the real thing. Every other write,
 * including one that carries an actual `INTEGRATION.md`, lands.
 *
 * ## Known limit: a doc that is ONE template block
 *
 * `isManifestTextFallback` is a `{`…`}` sniff, so an `INTEGRATION.md` whose
 * whole body is `{{ tmpl }}` reads as a manifest. The `stored` half of the
 * condition below therefore still mistakes such a doc for a refreshable
 * fallback and lets an editor save overwrite it. That half cannot simply be
 * dropped: without it, a manifest-shaped write is declined unconditionally and
 * the fallback can never be refreshed — the two requirements are mutually
 * exclusive under a shape test. Closing it needs a stronger predicate
 * (`JSON.parse` + a manifest-shaped check), which this sniff deliberately
 * avoids and which all four of its readers would inherit. Pinned as a known
 * case in `test/unit/package-files.test.ts`.
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
  // Nothing to protect — and returning `stored` here would hand back the very
  // `null` / `""` the signature promises never to produce.
  if (!stored) return incoming;
  return isManifestTextFallback(incoming) && !isManifestTextFallback(stored) ? stored : incoming;
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
type PackageFileValidator =
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

// ─────────────────────────────────────────────
// Draft tree writes
// ─────────────────────────────────────────────

/** One edit to a draft tree. Paths are archive-relative, `/`-separated. */
export type PackageFileOperation =
  | { op: "write"; path: string; bytes: Uint8Array }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

/**
 * Why a batch of operations was refused. Every value maps to one HTTP status at
 * the route boundary, which is where the mapping belongs — this module answers
 * WHAT is wrong, not with which number to say it.
 */
export type PackageFileWriteErrorCode =
  | "invalid_path"
  | "reserved_entry"
  | "content_entry_immovable"
  | "not_found"
  | "path_conflict"
  | "file_too_large"
  | "tree_too_large";

/** A refused draft-tree edit, carrying the offending path when there is one. */
export class PackageFileWriteError extends Error {
  constructor(
    readonly code: PackageFileWriteErrorCode,
    /** The path the caller named, or `null` for a whole-tree limit. */
    readonly path: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PackageFileWriteError";
  }
}

/**
 * A path an operation names must be one the archive can carry, and must not be
 * the manifest: `manifest.json` is a projection of `packages.draft_manifest`,
 * authored through the package `PUT` and validated by `validateManifestForRoute`.
 * Writing it as a file would put a second, unvalidated manifest in the tree.
 */
function assertOperandPath(path: string): void {
  if (!isSafeArchivePath(path)) {
    throw new PackageFileWriteError("invalid_path", path, `'${path}' is not a usable file path`);
  }
  if (path === PACKAGE_MANIFEST_FILE) {
    throw new PackageFileWriteError(
      "reserved_entry",
      path,
      `'${PACKAGE_MANIFEST_FILE}' is authored through the package manifest, not the file tree`,
    );
  }
}

/**
 * The form under which two archive entries are the SAME file once the tree is
 * written to a filesystem: Unicode-normalized (macOS and Linux disagree about
 * whether `é` is one code point or two, and a `git`-checked-out tree carries
 * whichever the author's editor emitted) and case-folded (APFS and NTFS are
 * case-insensitive by default).
 *
 * A ZIP is a flat list of byte strings, so it can carry `SKILL.md` and
 * `skill.md` at once; extracting it to `~/.claude/skills` on a Mac cannot. The
 * later of the two wins by sort order, which means the file the platform gated
 * (`assertArchiveContentConforms` reads `SKILL.md`) is not the file the runtime
 * loads. Refusing the second name is the only way both ends see one file.
 */
function indistinctName(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * Whole-tree invariants, checked once on the RESULT rather than per operation:
 * a batch is atomic, so every intermediate tree is allowed to be invalid (a
 * move is a delete the caller has not finished yet).
 *
 * `touched` — the paths this batch ADDS, i.e. the ones the result holds and the
 * input did not — scopes the two collision checks to what the caller is
 * responsible for. A stored ZIP is free to contain both `a` and `a/b` (a ZIP is
 * a flat list of names, not a filesystem), or both `A.md` and `a.md`, and
 * refusing every later edit of such a package would punish the author for an
 * archive they may not have built. Overwriting a path the tree already holds
 * introduces neither kind of collision, so it is not in `touched` — otherwise
 * saving an existing file of such a package would be refused forever.
 */
function assertTreeConforms(files: Record<string, Uint8Array>, touched: Iterable<string>): void {
  const paths = Object.keys(files);
  if (paths.length > ARCHIVE_MAX_FILES) {
    throw new PackageFileWriteError(
      "tree_too_large",
      null,
      `A package holds at most ${ARCHIVE_MAX_FILES} files; this one would hold ${paths.length}`,
    );
  }

  let total = 0;
  for (const path of paths) total += files[path]!.byteLength;
  if (total > PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES) {
    throw new PackageFileWriteError(
      "tree_too_large",
      null,
      `A package holds at most ${PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES} bytes of files; this one would hold ${total}`,
    );
  }

  // Every path that is used as a DIRECTORY by some entry of the result.
  const directories = new Set<string>();
  // Result paths keyed by the form two of them collapse to on the filesystems
  // this tree is materialized on.
  const byIndistinctName = new Map<string, string[]>();
  for (const path of paths) {
    for (let cut = path.indexOf("/"); cut >= 0; cut = path.indexOf("/", cut + 1)) {
      directories.add(path.slice(0, cut));
    }
    const key = indistinctName(path);
    const same = byIndistinctName.get(key);
    if (same) same.push(path);
    else byIndistinctName.set(key, [path]);
  }

  for (const path of touched) {
    const indistinct = byIndistinctName
      .get(indistinctName(path))!
      .filter((other) => other !== path);
    if (indistinct.length > 0) {
      throw new PackageFileWriteError(
        "path_conflict",
        path,
        `'${path}' and '${indistinct[0]}' are the same file on a case-insensitive filesystem`,
      );
    }
    if (directories.has(path)) {
      throw new PackageFileWriteError(
        "path_conflict",
        path,
        `'${path}' is a directory in this package and cannot also be a file`,
      );
    }
    for (let cut = path.indexOf("/"); cut >= 0; cut = path.indexOf("/", cut + 1)) {
      const ancestor = path.slice(0, cut);
      if (Object.hasOwn(files, ancestor)) {
        throw new PackageFileWriteError(
          "path_conflict",
          path,
          `'${ancestor}' is a file in this package, so '${path}' cannot be created under it`,
        );
      }
    }
  }
}

/**
 * Apply a batch of operations to a file tree and return a NEW tree.
 *
 * Pure: the input map is never mutated, and neither are the byte arrays (an
 * entry the batch does not touch is carried over by reference). Operations
 * apply IN ORDER, so a batch can move a file and then write the new path, or
 * delete a file it created earlier — the caller's sequence is the caller's.
 *
 * A `write` overwrites its path, because that is what saving a file means. A
 * `move` does NOT: a rename whose destination is taken is refused
 * (`path_conflict`), so the one gesture that carries a file the author cannot
 * see in the operation cannot destroy another one. A caller that means to
 * replace spells it out — `delete` the destination, then `move` onto the freed
 * path, in the same batch. Moving a file onto itself is a no-op.
 *
 * The type's content entry (`SKILL.md` / `prompt.md`) is authored by writing
 * it. It cannot be deleted or moved AWAY: a package of that type is defined by
 * having it, and `assertArchiveContentConforms` would refuse the result anyway,
 * with a message about frontmatter rather than about the operation the caller
 * asked for. Since it always exists, and deleting it is refused, it is not a
 * reachable move destination either.
 *
 * @throws PackageFileWriteError — the only failure mode.
 */
export function applyFileOperations(
  files: Record<string, Uint8Array>,
  ops: readonly PackageFileOperation[],
  ctx: { type: PackageType },
): Record<string, Uint8Array> {
  const contentEntry = PACKAGE_CONTENT_ENTRY[ctx.type]?.path ?? null;
  const result = { ...files };
  const touched = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case "write": {
        assertOperandPath(op.path);
        if (op.bytes.byteLength > PACKAGE_FILE_INLINE_MAX_BYTES) {
          throw new PackageFileWriteError(
            "file_too_large",
            op.path,
            `'${op.path}' is ${op.bytes.byteLength} bytes; a file written through the editor holds at most ${PACKAGE_FILE_INLINE_MAX_BYTES}`,
          );
        }
        // Only a path the INPUT tree did not hold is `touched`: overwriting an
        // entry that is already there changes bytes, never the set of names, so
        // it can introduce no collision with the names around it.
        if (!Object.hasOwn(files, op.path)) touched.add(op.path);
        result[op.path] = op.bytes;
        break;
      }
      case "delete": {
        assertOperandPath(op.path);
        if (op.path === contentEntry) {
          throw new PackageFileWriteError(
            "content_entry_immovable",
            op.path,
            `'${op.path}' is this package's content and cannot be deleted`,
          );
        }
        if (!Object.hasOwn(result, op.path)) {
          throw new PackageFileWriteError("not_found", op.path, `'${op.path}' does not exist`);
        }
        delete result[op.path];
        touched.delete(op.path);
        break;
      }
      case "move": {
        assertOperandPath(op.from);
        assertOperandPath(op.to);
        if (op.from === contentEntry) {
          throw new PackageFileWriteError(
            "content_entry_immovable",
            op.from,
            `'${op.from}' is this package's content and cannot be renamed`,
          );
        }
        if (!Object.hasOwn(result, op.from)) {
          throw new PackageFileWriteError("not_found", op.from, `'${op.from}' does not exist`);
        }
        if (op.to !== op.from && Object.hasOwn(result, op.to)) {
          throw new PackageFileWriteError("path_conflict", op.to, `'${op.to}' already exists`);
        }
        const bytes = result[op.from]!;
        delete result[op.from];
        touched.delete(op.from);
        // Same rule as `write`: a destination the input tree already held (this
        // batch freed it with an earlier `delete`) is not a new name.
        if (!Object.hasOwn(files, op.to)) touched.add(op.to);
        result[op.to] = bytes;
        break;
      }
    }
  }

  assertTreeConforms(result, touched);
  return result;
}

/**
 * What the caller claims about the tree it is modifying.
 *
 * `etag` is the index validator the caller read (`If-Match`), compared against
 * the tree under the lock — "the tree I am modifying is the tree I read". `*`
 * matches any current representation (RFC 9110 §13.1.1), for a scripted caller
 * that means to overwrite whatever is there. `lockVersion` is the row's
 * optimistic token, the package `PUT`'s contract.
 */
export type DraftFilesPrecondition = { etag: string } | { lockVersion: number };

export interface MutateDraftFilesInput {
  precondition: DraftFilesPrecondition;
  /** Transform the overlaid tree. Runs under the lock; must return a new map. */
  mutate: (files: Record<string, Uint8Array>) => Record<string, Uint8Array>;
  /** Manifest to persist with this write. Defaults to the row's current draft. */
  manifest?: Record<string, unknown>;
  /**
   * `packages.draft_content` to persist. Defaults to the resulting tree's
   * content entry, decoded — which is what the column IS for a type whose entry
   * is a real file. A type whose `content` is a manifest copy (`integration`,
   * `mcp-server`) resolves the column on its own terms and passes it here; see
   * {@link resolveDraftContent}.
   */
  draftContent?: string;
}

/**
 * The one read-modify-write of a package's draft tree.
 *
 * The EDITING writers go through here — the package `PUT`, the file-tree
 * `PATCH` and a version restore — because the tree lives in two stores: the
 * `packages` row (`draft_manifest` / `draft_content`, which the read overlay
 * lets WIN) and the ZIP object. Under one transaction-scoped advisory lock on
 * the package id, concurrent writers of one package queue instead of clobbering
 * each other's read-modify-write.
 *
 * Four writers do NOT, and the reason differs:
 *
 * - **create**, **import of a NEW id** and **fork** upload a package's first
 *   tree directly. There is no row a concurrent writer could have read, so
 *   there is nothing to serialize against.
 * - the **`system-packages/` boot sync** writes packages whose `orgId` is
 *   `null`; this helper scopes its row read by a real org and cannot address
 *   them.
 * - **`postInstallPackage`** — an import over a package that already exists —
 *   is the one that genuinely could and does not, for two reasons stated at its
 *   own header: the content gate below is deliberately not applied to a
 *   bundle's non-root packages, and that path persists a raw manifest into the
 *   version while the row takes a normalized one. Its row write and its upload
 *   are therefore NOT serialized against the editor's, and an import landing
 *   mid-save can drop a file the `PATCH` just stored.
 *
 * ## Why the row is written before the object
 *
 * No transaction spans PostgreSQL and object storage, so one of the two lands
 * first and a crash between them leaves a skew. The order is chosen so that the
 * skew a failure produces is the smallest one available, not a harmless one:
 *
 * - The storage upload runs INSIDE the transaction. When it fails — the likely
 *   failure of the two, being a network round-trip — the row update rolls back
 *   with it and the write simply did not happen.
 * - When the upload succeeds and the COMMIT then fails, the object is ahead of
 *   the row and the caller has a `500`. What the overlay hides is exactly the
 *   two entries it owns: the type's content entry and `manifest.json` read back
 *   at their pre-write values, so the author's `SKILL.md` edit did not land.
 *   Every OTHER entry of the batch DID: an ancillary file it wrote is now
 *   listed, one it deleted is gone, one it moved sits at its new path — while
 *   `lock_version` did not move and nothing told the caller. A delete that
 *   lands in that window is not recoverable through this route; the version the
 *   file was published in is where those bytes still exist. Closing it means
 *   storing each write as its own content-addressed object and swapping a
 *   pointer, which is a storage layout this package does not have.
 *
 * The lock is therefore held across the storage round-trip. That is the cost of
 * writes to one package being serialized at all, and writes to one package are
 * what the editor produces. It is NOT the lock the publish path takes
 * (`pg_advisory_xact_lock(hashtext(id))`, `package-versions.ts`): that one
 * guards the `package_versions` rows and dist-tags, and publish reads the draft
 * tree it freezes before entering it, so the two key spaces are deliberately
 * distinct rather than accidentally so.
 *
 * @returns the tree a subsequent `GET …/files` will report, and the row's new
 *   `lock_version`.
 * @throws 404 when the package is not in the org, 412 / 409 when the
 *   precondition fails, and whatever `mutate` or the content gate throws.
 */
export async function mutatePackageDraftFiles(
  target: { id: string; type: PackageType; orgId: string },
  input: MutateDraftFilesInput,
): Promise<{ snapshot: PackageFileSnapshot; lockVersion: number }> {
  const lockKey = `package-files:${target.id}`;
  const label = CONFIG_BY_TYPE[target.type].labelSingular;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);

    const [row] = await tx
      .select({
        draftManifest: packages.draftManifest,
        draftContent: packages.draftContent,
        lockVersion: packages.lockVersion,
      })
      .from(packages)
      .where(and(eq(packages.id, target.id), eq(packages.orgId, target.orgId)))
      .limit(1);
    if (!row) throw notFound(`${label} '${target.id}' not found`);

    const source: PackageFileSource = {
      id: target.id,
      type: target.type,
      orgId: target.orgId,
      draftManifest: row.draftManifest,
      draftContent: row.draftContent,
    };

    const before = await readPackageSnapshot(source, {
      kind: "draft",
      snapshotId: null,
      yanked: false,
    });

    if ("etag" in input.precondition) {
      const presented = input.precondition.etag;
      if (presented !== "*" && presented !== indexEtag(before.snapshotId)) {
        throw preconditionFailed(
          `${label} '${target.id}' changed since its files were read. Reload and try again.`,
        );
      }
    } else if (input.precondition.lockVersion !== row.lockVersion) {
      throw conflict("conflict", `${label} was modified concurrently. Reload and try again.`);
    }

    const mutated = input.mutate(before.files);
    // The bytes ABOUT TO BE STORED, not the ones the caller sent: a write that
    // leaves the content entry unparseable is refused before either store moves.
    assertArchiveContentConforms(target.type, mutated, "file");

    const entry = PACKAGE_CONTENT_ENTRY[target.type];
    const contentBytes = entry ? mutated[entry.path] : undefined;
    const draftContent =
      input.draftContent ??
      (contentBytes ? decodeSkillMarkdown(contentBytes) : (row.draftContent ?? ""));

    const updated = await updateOrgItem(
      target.orgId,
      target.id,
      { manifest: input.manifest ?? asRecord(row.draftManifest), content: draftContent },
      row.lockVersion,
      tx,
    );
    // The advisory lock only binds writers that take it. A writer that bumps
    // `lock_version` without it (a re-install, a version restore) still loses
    // this update, and the caller is told so rather than being told the write
    // landed.
    if (!updated) {
      throw conflict("conflict", `${label} was modified concurrently. Reload and try again.`);
    }

    const stored = { ...mutated };
    if (!CONFIG_BY_TYPE[target.type].manifestIsStoredFile) delete stored[PACKAGE_MANIFEST_FILE];
    await uploadPackageFiles(
      CONFIG_BY_TYPE[target.type].storageFolder,
      target.orgId,
      target.id,
      stored,
    );

    // What the next read will produce: the stored tree with the overlay of the
    // row we just wrote. Building it from the UPDATED row is what makes the
    // returned `snapshotId` — and the ETag derived from it — the one a
    // subsequent conditional request presents.
    const files = { ...stored };
    applyDraftOverlay(files, {
      ...source,
      draftManifest: updated.draftManifest,
      draftContent: updated.draftContent,
    });

    logger.info("Package draft tree written", {
      packageId: target.id,
      fileCount: Object.keys(stored).length,
      lockVersion: updated.lockVersion,
    });

    return {
      snapshot: { files, snapshotId: draftSnapshotId(files) },
      lockVersion: updated.lockVersion,
    };
  });
}
