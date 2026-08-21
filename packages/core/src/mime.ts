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
 */

export {
  normalizeMime,
  TEXT_SHAPED_MEDIA_TYPES,
  isTextShapedMime,
  isTextShapedContentType,
} from "@appstrate/afps-shared/mime";
