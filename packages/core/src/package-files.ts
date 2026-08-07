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

/**
 * Which archive entry holds a package's PRIMARY CONTENT, per type — the one
 * file a package of that type is authored around.
 *
 * `null` means the type has no such entry: its content *is* `manifest.json`,
 * and the value stored alongside the package is a redundant copy of the
 * manifest text rather than a file of its own.
 *
 * One declaration, several readers that must agree:
 *
 * - **Import** (`packages/core/src/zip.ts`, `parsePackageZip`) — reads this
 *   entry out of the ZIP and returns it as `content`, which the platform
 *   persists into `packages.draft_content`.
 * - **File explorer** (`apps/api/src/services/package-files.ts`) — overlays
 *   `packages.draft_content` back ONTO this entry, because the DB row is
 *   written before the ZIP is re-uploaded and therefore wins over it.
 *
 * The overlay is the exact inverse of the extraction, so a disagreement about
 * which entry it is would either erase a real file or invent one the package
 * does not ship. They were separate switch statements before.
 *
 * NOTE — this map names the file; it does not describe what happens when the
 * file is absent. `INTEGRATION.md` is an optional companion, and both readers
 * handle its absence in their own way (import falls back to the manifest text;
 * the explorer declines to materialize an entry that is not there).
 */
export const PACKAGE_CONTENT_FILE: Record<PackageType, string | null> = {
  agent: "prompt.md",
  skill: "SKILL.md",
  integration: "INTEGRATION.md",
  "mcp-server": null,
};
