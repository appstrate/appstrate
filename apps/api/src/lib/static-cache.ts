// SPDX-License-Identifier: Apache-2.0

/**
 * `Cache-Control` policy for the statically served SPA build.
 *
 * The static middleware (`serveStatic` in `index.ts`) emits `Content-Type` and
 * nothing else — no `Cache-Control`, no `ETag`, no `Last-Modified`. Every asset
 * of every page view is therefore re-downloaded in full on every visit: there
 * is no validator for the browser to revalidate with, so there is no `304`
 * either. This module is the single source of truth for the header that closes
 * that, applied through the middleware's `onFound` callback.
 *
 * Two classes of file, distinguished by whether the FILENAME carries a content
 * hash:
 *
 *  - `assets/*` — emitted by Vite with a content hash in the name
 *    (`index-DRqZyykT.js`). The bytes behind a given name can never change, so
 *    the response is `immutable` for a year: a repeat visit issues no request
 *    at all. A rebuild changes the hash, hence the URL, hence the cache entry.
 *  - everything else — `favicon.ico`, `logo.svg`, `site.webmanifest`,
 *    `.well-known/*`: STABLE names whose bytes CAN change under them. These get
 *    a short TTL instead. `immutable` here would pin a stale favicon for a year
 *    with no way to bust it short of renaming the file.
 *
 * The SPA document itself is not served by this middleware (it is rewritten to
 * `/.noop` and handled by `routes/spa.ts`), and must never be cached: it embeds
 * a per-request `window.__APP_CONFIG__` and points at the current build's asset
 * hashes. Its header lives next to the handler that injects the config.
 */

/** Content-hashed build output: safe to pin for a year, never revalidated. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Stable-name static files (favicons, logos, manifest, `.well-known`). Short
 * enough that replacing one propagates in minutes, long enough to cut the
 * per-navigation refetch.
 */
export const SHORT_LIVED_CACHE_CONTROL = "public, max-age=300";

/**
 * The SPA shell. `no-cache` does NOT mean "do not store" — it means "always
 * revalidate before reuse", which is exactly right for a file that carries
 * per-request config and must never pin an old build's asset hashes.
 */
export const SPA_HTML_CACHE_CONTROL = "no-cache";

/**
 * Pick the `Cache-Control` value for a file the static middleware resolved.
 *
 * @param path Filesystem path the middleware served, as handed to `onFound`
 *   (e.g. `./apps/web/dist/assets/index-DRqZyykT.js`). Only the location of the
 *   `assets/` segment matters; the root prefix is irrelevant.
 * @returns The header value — `immutable` for content-hashed `assets/*`, a
 *   short TTL for everything else.
 */
export function staticCacheControl(path: string): string {
  // Normalize Windows separators so the segment test is platform-agnostic, then
  // match `assets/` as a whole PATH SEGMENT: a file named `my-assets/x.js` (or
  // `assets.js`) is not Vite build output and must not be pinned for a year.
  const normalized = path.replace(/\\/g, "/");
  return /(?:^|\/)assets\/[^/]+$/.test(normalized)
    ? IMMUTABLE_CACHE_CONTROL
    : SHORT_LIVED_CACHE_CONTROL;
}
