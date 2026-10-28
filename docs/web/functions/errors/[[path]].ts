// SPDX-License-Identifier: Apache-2.0

/**
 * Cloudflare Pages Function: resolver for the RFC 9457 `type` URIs Appstrate emits,
 * `/errors/{code}` (`codeToType()` in packages/core/src/api-errors.ts).
 *
 * Every URI redirects to a row of the errors page, whose anchors are
 * `code-<kebab>` (docs/site/api/errors.mdx). Normalisation is lossy on purpose:
 * lowercase, and underscores to dashes, so the raw `code` of a JSON body
 * resolves as well as the dashed `type` URI. Anything outside `[a-z0-9-]`
 * after that is dropped, so nothing the caller sends reaches the `Location`
 * header. An unknown code, or a deeper path, still lands on the page, at the
 * top, rather than on a 404.
 *
 * 307, not 308: the mapping is stable, but per-code pages may be served here
 * later, and a permanently cached redirect is hard to undo.
 */

const ERRORS_PAGE = '/api/errors';
const ANCHOR_PREFIX = 'code-';
/** Longest real code today is 34 characters; 64 is generous. */
const MAX_CODE_LENGTH = 64;

function anchorFor(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/_/g, '-');
  if (slug.length === 0 || slug.length > MAX_CODE_LENGTH) return null;
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return `${ANCHOR_PREFIX}${slug}`;
}

/** The errors page location a path under /errors resolves to. */
function errorsLocation(segments: readonly string[]): string {
  const [code] = segments;
  if (segments.length !== 1 || code === undefined) return ERRORS_PAGE;
  const anchor = anchorFor(code);
  return anchor ? `${ERRORS_PAGE}#${anchor}` : ERRORS_PAGE;
}

export function onRequest(context: { params: { path?: string | string[] } }): Response {
  const { path } = context.params;
  const segments = (Array.isArray(path) ? path : path ? [path] : []).filter((s) => s.length > 0);
  return new Response(null, {
    status: 307,
    headers: {
      Location: errorsLocation(segments),
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
    },
  });
}
