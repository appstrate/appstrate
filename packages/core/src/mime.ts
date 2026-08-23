// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MIME classification primitives — re-exported from the shared
 * zero-dependency `@appstrate/afps-shared` package. The `@appstrate/core/mime`
 * public surface is preserved verbatim (`normalizeMime`,
 * `TEXT_SHAPED_MEDIA_TYPES`, `isTextShapedMime`, `isTextShapedContentType`).
 *
 * The implementations live in `@appstrate/afps-shared/mime` so the outbound
 * HTTP engine in `@appstrate/afps-runtime` (which ships with the standalone
 * `afps` CLI and must NOT take a runtime dependency on `@appstrate/core`)
 * reaches the exact same media-type set as the platform upload-sniff policy
 * and the sidecar's `api_call` classifier. Before this move the runtime kept a
 * hand-copy guarded by a parity test; the copy drifted three times regardless,
 * once classifying XLSX as XML and corrupting every OOXML download.
 *
 * See `@appstrate/afps-shared/mime` for the full contract, including why
 * `application/octet-stream` is deliberately absent from the text set.
 *
 * {@link isImageMime} is the one primitive defined HERE rather than re-exported
 * — see its own note for why it does not belong in the shared module.
 */

export {
  normalizeMime,
  TEXT_SHAPED_MEDIA_TYPES,
  isTextShapedMime,
  isTextShapedContentType,
} from "@appstrate/afps-shared/mime";

/**
 * True for an `image/*` mime — the only content any surface renders as a
 * thumbnail (the gallery tiles, the run Files tab tiles, the chat attachment
 * chips).
 *
 * Lives here, not in the web shell, for the same reason
 * `PUBLISHED_FILE_LOG_EVENTS` lives in `@appstrate/core/file-uri`: two
 * independent renderers of the same file rows — the shell's file surfaces and
 * the chat module's attachment chips — must agree on which rows get a
 * thumbnail, and each kept its own verbatim copy of the predicate. The shell's
 * copy even carried a docblock claiming the module consumed it, which it never
 * did.
 *
 * Local to core rather than pushed down into `@appstrate/afps-shared`: this is
 * a PRESENTATION classification (does it render as a picture), not the
 * text-vs-binary transport policy the shared module owns, and no `afps-runtime`
 * consumer asks the question.
 */
export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime?.startsWith("image/");
}
