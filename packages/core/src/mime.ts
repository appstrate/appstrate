// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MIME classification primitives — re-exported from the shared
 * zero-internal-dependency `@appstrate/afps-shared` package. The `@appstrate/core/mime`
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

import { normalizeMime } from "@appstrate/afps-shared/mime";

export {
  normalizeMime,
  TEXT_SHAPED_MEDIA_TYPES,
  isTextShapedMime,
  isTextShapedContentType,
} from "@appstrate/afps-shared/mime";

/**
 * True for an `image/*` mime — the only content any surface renders as a
 * thumbnail (the file tiles, the chat attachment chips).
 *
 * Lives here, not in the web shell, for the same reason
 * `PUBLISHED_FILE_LOG_EVENT` lives in `@appstrate/core/file-uri`: two
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

/**
 * The four ways a file can be previewed in-browser (or null for "not
 * previewable"). Drives BOTH the DTO's `preview_kind`/`previewable` derivation
 * AND the preview route's serving branch — a single source of truth, so the set
 * of previewable types can never drift between "advertised as previewable" and
 * "actually served". Lives in core because the shell and the chat module ask
 * the same question of a file not yet sent ({@link localPreviewKind}).
 */
export type PreviewKind = "html" | "image" | "pdf" | "text";

/**
 * Image mimes served inline, byte-for-byte. Deliberately EXCLUDES
 * `image/svg+xml`: an SVG is ACTIVE content (it can embed `<script>` and event
 * handlers and runs in the embedding context), so it is not inert like a raster
 * image. Routing it safely would mean serving it through the full HTML-style
 * CSP + `sandbox="allow-scripts"` hardening — extra machinery for a rare case —
 * so instead SVG is simply not previewable (still downloadable). See
 * docs/architecture/FILES.md → "Preview kinds".
 */
const PREVIEW_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Text-family mimes previewed as PLAINTEXT. A conservative allowlist, NOT a
 * blanket `text/*`: every entry is inert once the route relabels it
 * `text/plain` (killing any markdown→HTML sniff surface). `application/json` is
 * the common structured-text case; `application/xml` / SVG are excluded (XML can
 * host active content).
 */
const PREVIEW_TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/**
 * Classify a file's mime into its {@link PreviewKind}, or null when it is
 * not previewable. Tolerates a parameterized mime (`text/plain; charset=…`) —
 * only the type/subtype is matched.
 */
export function previewKind(mime: string): PreviewKind | null {
  const base = normalizeMime(mime);
  if (base === "text/html") return "html";
  if (base === "application/pdf") return "pdf";
  if (PREVIEW_IMAGE_MIMES.has(base)) return "image";
  if (PREVIEW_TEXT_MIMES.has(base)) return "text";
  return null;
}

/**
 * The {@link PreviewKind} a browser shows from its OWN copy of a file (a `blob:`
 * URL of a file picked but not yet sent), or null. A subset of
 * {@link previewKind}, so a file previewable before sending stays previewable
 * after. `pdf` is framed from the `blob:` URL (the SPA's `frame-src` allows
 * `blob:`); `html` is excluded: it needs the server's sandboxed preview origin.
 */
export function localPreviewKind(mime: string): "image" | "pdf" | "text" | null {
  const kind = previewKind(mime);
  return kind === "image" || kind === "pdf" || kind === "text" ? kind : null;
}
