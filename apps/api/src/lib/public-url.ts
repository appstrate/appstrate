// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { propagateRequestClientIp } from "./client-ip.ts";

/** Canonical browser-facing origin for every URL that leaves the process. */
export function getPublicAppOrigin(): string {
  return getEnv().APP_URL;
}

/**
 * Preserve an internal request's path/query/fragment while replacing the
 * proxy-facing scheme and authority with the configured public origin.
 */
export function toPublicAppUrl(input: string | URL): URL {
  const source = input instanceof URL ? input : new URL(input, getPublicAppOrigin());
  return new URL(`${source.pathname}${source.search}${source.hash}`, getPublicAppOrigin());
}

/**
 * Canonicalize the request URL without changing its method, headers or body.
 * Better Auth reads the request URL for provider redirects and DPoP `htu`.
 */
export function withPublicAppOrigin(request: Request): Request {
  const canonical = new Request(toPublicAppUrl(request.url).toString(), request);
  // client-ip.ts stores the socket-derived address by Request identity for
  // Better Auth plugins that never receive a Hono context. Re-key it whenever
  // this boundary replaces the Request so rate limiting remains effective.
  propagateRequestClientIp(request, canonical);
  return canonical;
}
