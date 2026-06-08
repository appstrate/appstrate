// SPDX-License-Identifier: Apache-2.0

/**
 * Internal self-dispatch marker.
 *
 * When a module re-enters the platform in-process via `app.fetch()` (the MCP
 * server's `invoke_operation` is the only caller today — see
 * `modules/mcp/tools.ts`), the synthetic request carries the SAME bearer token
 * the external caller presented. That token may be audience-bound to a single
 * protected resource (e.g. `/api/mcp`); the outbound half of
 * `enforceResourceAudience` (`auth-pipeline.ts`) rejects such a token on any
 * route OUTSIDE its resource so it cannot be lifted and replayed against the
 * rest of the API.
 *
 * The in-process dispatch is the one legitimate exception: it targets a
 * non-resource route (`/api/agents`, …) but has ALREADY cleared the resource
 * boundary's inbound audience check at `/api/mcp`. We mark it with a per-process
 * secret header so the confinement middleware can let it through without
 * opening a forgeable bypass.
 *
 * Security properties:
 * - The token is 256 bits of CSPRNG output minted once per process and never
 *   leaves it (never logged, never serialized into a response). An external
 *   attacker cannot guess it, so sending the header name on a direct request
 *   does nothing.
 * - The comparison is constant-time, so the marker cannot be brute-forced via
 *   response-timing analysis.
 * - The marker grants exactly ONE thing: an exemption from outbound resource
 *   confinement. It does not authenticate, elevate, or alter identity — the
 *   dispatched request still runs the full auth pipeline + RBAC.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Lower-case so it round-trips through `Headers` (which lower-cases names). */
const INTERNAL_DISPATCH_HEADER = "x-appstrate-internal-dispatch";

/** Per-process secret. Regenerated every boot — no persistence, no config. */
const DISPATCH_TOKEN = randomBytes(32).toString("hex");
const DISPATCH_TOKEN_BYTES = Buffer.from(DISPATCH_TOKEN, "utf8");

/**
 * Header name + value to stamp onto an in-process dispatched request. Returned
 * as a tuple so the caller does `headers.set(...internalDispatchHeader())`.
 */
export function internalDispatchHeader(): readonly [string, string] {
  return [INTERNAL_DISPATCH_HEADER, DISPATCH_TOKEN];
}

/**
 * True iff `headers` carries the current process's internal-dispatch marker.
 * Constant-time on the value; a length mismatch (the common case for a forged
 * or absent header) short-circuits without leaking position information, which
 * is safe because the token length is a fixed public constant.
 */
export function isInternalDispatch(headers: Headers): boolean {
  const value = headers.get(INTERNAL_DISPATCH_HEADER);
  if (value === null) return false;
  const candidate = Buffer.from(value, "utf8");
  if (candidate.length !== DISPATCH_TOKEN_BYTES.length) return false;
  return timingSafeEqual(candidate, DISPATCH_TOKEN_BYTES);
}
