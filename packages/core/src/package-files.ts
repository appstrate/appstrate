// SPDX-License-Identifier: Apache-2.0

/**
 * Facts about a package's files that several enforcement points must agree on,
 * declared once.
 *
 * The module carries **no value imports** — the SPA bundles it into the
 * browser, so anything it pulled in would be pulled in there too. The single
 * `import type` below is erased at build time and costs nothing. Keep it that
 * way: this file is a place for constants, not for logic.
 */

import type { PackageType } from "./validation.ts";

/**
 * Size ceiling of the package file explorer, shared by both ends of the wire.
 *
 * One threshold, two enforcements that must agree:
 *
 * - **Server** (`apps/api/src/services/package-files.ts`) — a file at most this
 *   many bytes is decoded and its full text carried in the index response's
 *   `inline` field. Above it the file is never decoded: it is classified by
 *   extension alone and never inlined.
 * - **Client** (`apps/web/src/lib/package-file-tree.ts`) — a file above this
 *   size is never previewed; `previewBlockReason` returns `"too_large"`.
 *
 * The ceiling is **INCLUSIVE**: `size <= PACKAGE_FILE_INLINE_MAX_BYTES` is
 * allowed on both sides, so a file of exactly this size is still inlined by the
 * server and still previewable by the client.
 *
 * They were two independent declarations kept in manual lockstep; a drift would
 * mean the UI offering a preview the index never carries `inline` for, or
 * refusing one it already holds. This module exists solely to make that kind of
 * drift impossible.
 */
export const PACKAGE_FILE_INLINE_MAX_BYTES = 1_048_576;

/** One package type's primary-content entry: which file, and whether it is mandatory. */
export interface PackageContentEntry {
  /** Archive path of the entry, at the bundle root. */
  path: string;
  /**
   * Whether a package of this type ALWAYS carries the entry. `false` means a
   * reader must check the entry is actually there before acting on it — see
   * the `integration` case on {@link PACKAGE_CONTENT_ENTRY}.
   */
  required: boolean;
}

/**
 * Which archive entry holds a package's PRIMARY CONTENT, per type — the one
 * file a package of that type is authored around — and whether that entry is
 * mandatory. Three states, all three declared here:
 *
 * - **`{ required: true }`** — `agent` → `prompt.md`, `skill` → `SKILL.md`. The
 *   package always has the entry: the import path rejects a bundle without it,
 *   and `packages.draft_content` is genuinely that file's only copy, so the
 *   explorer materializes it even when no ZIP is stored yet (a freshly created
 *   package has none, and must still list its single file).
 * - **`{ required: false }`** — `integration` → `INTEGRATION.md`, an OPTIONAL
 *   agent-facing companion. When a bundle ships without one, the import path
 *   stores the MANIFEST TEXT in `draft_content` instead; materializing that
 *   column unconditionally would invent an `INTEGRATION.md` whose body is the
 *   package's own manifest. So a reader must overlay it only on top of an
 *   entry that already exists.
 * - **`null`** — `mcp-server` has no such entry at all: its content *is*
 *   `manifest.json` (AFPS §3.4), and the value stored alongside the package is
 *   a redundant copy of the manifest text rather than a file of its own.
 *
 * `required` belongs here because it is a property of the TYPE, exactly like
 * the filename is. It was a `type === "integration"` literal inside the
 * explorer's overlay — one `if` away from the map it was qualifying, and free
 * to drift from it.
 *
 * One declaration, several readers that must agree:
 *
 * - **Import** (`packages/core/src/zip.ts`, `parsePackageZip`) — reads this
 *   entry out of the ZIP and returns it as `content`, which the platform
 *   persists into `packages.draft_content`.
 * - **File explorer** (`apps/api/src/services/package-files.ts`) — overlays
 *   `packages.draft_content` back ONTO this entry, because the DB row is
 *   written before the ZIP is re-uploaded and therefore wins over it.
 * - **Package UI** (`apps/web/src/lib/package-files.ts`) — names the editor's
 *   content tab and the entry the file explorer pre-selects.
 *
 * The overlay is the exact inverse of the extraction, so a disagreement about
 * which entry it is would either erase a real file or invent one the package
 * does not ship. They were separate switch statements before.
 *
 * Presence is *enforced* at import time by `checkCompanionFiles`
 * (`@appstrate/afps-shared`), which sits BELOW core in the dependency graph and
 * therefore cannot read this table — it states the same requirement in its own
 * per-type rules, alongside checks this table has no way to express (a
 * non-empty `prompt.md`, a `name` in `SKILL.md`'s frontmatter).
 */
export const PACKAGE_CONTENT_ENTRY: Record<PackageType, PackageContentEntry | null> = {
  agent: { path: "prompt.md", required: true },
  skill: { path: "SKILL.md", required: true },
  integration: { path: "INTEGRATION.md", required: false },
  "mcp-server": null,
};

/**
 * Name-only projection of {@link PACKAGE_CONTENT_ENTRY}, for readers that need
 * the filename and nothing else (the package UI's tab labels, the ZIP
 * extractor). DERIVED, never declared a second time — the two cannot drift.
 */
export const PACKAGE_CONTENT_FILE: Record<PackageType, string | null> = Object.fromEntries(
  Object.entries(PACKAGE_CONTENT_ENTRY).map(([type, entry]): [string, string | null] => [
    type,
    entry?.path ?? null,
  ]),
  // `Object.entries` / `Object.fromEntries` widen the key back to `string`; the
  // input is already keyed by `PackageType`, so the assertion below only
  // restores what the round-trip erased — it does not claim anything new.
) as Record<PackageType, string | null>;
