// SPDX-License-Identifier: Apache-2.0

/**
 * The #1177 `documents` → `files` PATH rename, spelled once.
 *
 * Every `…/files…` route the platform serves is ALSO registered under its
 * pre-#1177 `…/documents…` spelling (`routes/files.ts`, `routes/runs-events.ts`):
 * one handler, two registered patterns. Anything keyed on the REGISTERED
 * pattern therefore sees two endpoints where there is one, and that is a
 * defect, not a cosmetic duplicate:
 *
 *   - the per-endpoint rate limiter (`middleware/rate-limit.ts`) hands a client
 *     that alternates spellings TWO buckets — double the intended budget, on an
 *     endpoint that proxy-streams up to `DOCUMENT_MAX_FILE_BYTES`, and on the
 *     IP-keyed unauthenticated preview route;
 *   - the published spec has to derive the deprecated alias of every canonical
 *     path (`openapi/paths/files.ts`).
 *
 * Both directions are generated from the ONE segment pair below, so the next
 * alias (or retiring these) is a single edit rather than a hunt through every
 * `rateLimit()` call site. Only whole path SEGMENTS are rewritten, so the same
 * helpers are correct on Hono patterns (`:id`) and OpenAPI templates (`{id}`).
 *
 * The rename is total — there is no `…/documents…` route that is not the alias
 * of its `…/files…` twin — which is what makes a blanket segment rewrite safe.
 * If a genuinely different `documents` resource is ever introduced, it must not
 * reuse this segment, or these two functions stop being sound.
 */

const CANONICAL_SEGMENT = "files";
const LEGACY_SEGMENT = "documents";

const CANONICAL_SEGMENT_RE = new RegExp(`(^|/)${CANONICAL_SEGMENT}(?=/|$)`, "g");
const LEGACY_SEGMENT_RE = new RegExp(`(^|/)${LEGACY_SEGMENT}(?=/|$)`, "g");

/**
 * The deprecated spelling of a canonical path:
 * `/api/files/{id}/content` → `/api/documents/{id}/content`.
 */
export function legacyFilesPath(canonicalPath: string): string {
  return canonicalPath.replace(CANONICAL_SEGMENT_RE, `$1${LEGACY_SEGMENT}`);
}

/**
 * The canonical spelling of a possibly-deprecated path:
 * `/api/documents/:id/content` → `/api/files/:id/content`. Any path without a
 * `documents` segment is returned unchanged.
 */
export function canonicalFilesPath(path: string): string {
  return path.replace(LEGACY_SEGMENT_RE, `$1${CANONICAL_SEGMENT}`);
}
