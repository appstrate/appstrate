// SPDX-License-Identifier: Apache-2.0

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
 * refusing one it already holds. This module exists solely to make that
 * impossible, which is why it has no imports and exports nothing else — the SPA
 * bundles it into the browser.
 */
export const PACKAGE_FILE_INLINE_MAX_BYTES = 1_048_576;
