// SPDX-License-Identifier: Apache-2.0

import { cors } from "hono/cors";
import { VIEW_AS_ACTIVE_HEADER } from "@appstrate/core/permissions";

/**
 * Every non-safelisted response header a browser client reads; a cross-origin
 * browser hides any header not in `Access-Control-Expose-Headers`.
 */
export const CORS_EXPOSED_HEADERS: readonly string[] = [
  "Request-Id",
  "Appstrate-Version",
  "Link",
  "Location",
  "ETag",
  "Allow",
  "Retry-After",
  "RateLimit",
  "RateLimit-Policy",
  "Idempotent-Replayed",
  "WWW-Authenticate",
  "Content-Disposition",
  "Repr-Digest",
  VIEW_AS_ACTIVE_HEADER,
  "X-Bundle-Integrity",
  "X-Bundle-Version",
  "X-Integrity",
  "X-Yanked",
];

/** The API's CORS policy — shared by the server and the test harness. */
export function apiCors(origin: string | string[]) {
  return cors({ origin, credentials: true, exposeHeaders: [...CORS_EXPOSED_HEADERS] });
}
