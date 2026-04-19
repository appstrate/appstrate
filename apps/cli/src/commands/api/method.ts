// SPDX-License-Identifier: Apache-2.0

import type { ApiCommandOptions } from "./types.ts";

/**
 * HTTP methods we accept as the first positional when the user writes
 * `appstrate api POST /x`. Matches curl's list, minus CONNECT/TRACE
 * which aren't meaningful over fetch().
 */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function isHttpMethod(s: string): boolean {
  return HTTP_METHODS.has(s.toUpperCase());
}

export function pickMethod(opts: ApiCommandOptions, hasBody: boolean): string {
  // Precedence (highest → lowest): -I, -X, positional, -T (PUT),
  // body → POST, else GET. Matches curl's inference.
  if (opts.head) return "HEAD";
  if (opts.request) return opts.request.toUpperCase();
  if (opts.method) return opts.method.toUpperCase();
  if (opts.uploadFile !== undefined) return "PUT";
  return hasBody ? "POST" : "GET";
}
