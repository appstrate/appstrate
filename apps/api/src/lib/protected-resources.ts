// SPDX-License-Identifier: Apache-2.0

/**
 * Generic protected-resource registry + RFC 8707 audience confinement.
 *
 * A "protected resource" is an OAuth resource server mounted inside the
 * platform that issues audience-bound access tokens (RFC 8707) — currently
 * only the inbound MCP server at `/api/mcp`. A spec-compliant client obtains a
 * token whose `aud` is that resource's canonical URI, and the resource MUST
 * reject tokens not issued for it (MCP authorization spec, 2025-11-25).
 *
 * This registry generalises that contract so the audience rule lives in ONE
 * place instead of being special-cased per path inside the shared auth
 * pipeline (mirrors `auth-challenges.ts`). A resource registers its path prefix
 * + canonical URI once; `enforceResourceAudience` then enforces both halves of
 * audience binding for every bearer token:
 *
 * - **Inbound** — a request to a registered resource path must present a token
 *   whose `aud` includes that resource's URI, else 401. (Generalises the old
 *   `requireMcpAudience`.)
 * - **Outbound** — a token whose `aud` is bound to a registered resource may
 *   NOT be used on any route OUTSIDE that resource. This stops an
 *   audience-scoped token (e.g. an MCP client's, which carries the connecting
 *   user's full authority) from being lifted and replayed against the rest of
 *   the REST API. The one legitimate exception is an in-process self-dispatch
 *   that already cleared a resource boundary inbound (`invoke_operation`),
 *   identified by the unforgeable internal-dispatch marker.
 *
 * Only OAuth bearer tokens carry an audience (the oidc strategy surfaces it as
 * `authExtra.tokenAudiences`). Cookie sessions and API keys carry none, so
 * first-party callers are never touched by either half.
 *
 * Zero footprint when unused: an empty registry makes the middleware a
 * pass-through, so a disabled MCP module leaves no trace.
 */

import type { Context, MiddlewareHandler } from "hono";
import { unauthorized } from "./errors.ts";
import { isInternalDispatch } from "./internal-dispatch.ts";
import type { AppEnv } from "../types/index.ts";

interface Entry {
  prefix: string;
  /** Lazy so the URI is read at request time (depends on env `APP_URL`). */
  uri: () => string;
}

const entries: Entry[] = [];

/**
 * Register a protected resource. Idempotent per prefix (re-registering
 * replaces — safe across test-harness module reloads). Matched
 * longest-prefix-first so a more specific resource wins over a broader one.
 */
export function registerProtectedResource(prefix: string, uri: () => string): void {
  const existing = entries.findIndex((e) => e.prefix === prefix);
  if (existing >= 0) entries[existing] = { prefix, uri };
  else entries.push({ prefix, uri });
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Test-only: clear the registry between cases. */
export function resetProtectedResources(): void {
  entries.length = 0;
}

/** The resource whose prefix matches `path`, if any (longest-prefix-first). */
export function resolveProtectedResource(
  path: string,
): { prefix: string; uri: string } | undefined {
  const entry = entries.find((e) => path === e.prefix || path.startsWith(`${e.prefix}/`));
  return entry ? { prefix: entry.prefix, uri: entry.uri() } : undefined;
}

/** Canonical URIs of every registered resource (for outbound confinement). */
export function listProtectedResourceUris(): string[] {
  return entries.map((e) => e.uri());
}

/**
 * Middleware enforcing both halves of RFC 8707 audience binding (see file
 * docblock). Runs after the auth middleware has resolved `authExtra`, gated by
 * the caller on `skipAuth` + an authenticated user so it never fires for public
 * paths or unauthenticated requests (those 401 earlier). No-op for any caller
 * without a bearer-token audience.
 */
export function enforceResourceAudience(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const extra = c.get("authExtra") as { tokenAudiences?: unknown } | undefined;
    const audiences = extra?.tokenAudiences;
    // No bearer-token audience → cookie/API-key first-party caller. Nothing to
    // confine; the token model carries no resource scoping.
    if (!Array.isArray(audiences)) return next();

    const target = resolveProtectedResource(c.req.path);

    // Inbound: a request to a protected resource must carry that resource in
    // its audience (RFC 8707 / RFC 9728 / MCP MUST). The auth-challenge
    // responder turns this 401 into a WWW-Authenticate so the client can
    // re-acquire a correctly-scoped token.
    if (target) {
      if (!audiences.includes(target.uri)) {
        throw unauthorized(
          `Access token is not audience-bound to this resource (${target.prefix}).`,
        );
      }
      return next();
    }

    // Outbound: this route is not a protected resource. A token bound to one
    // may not be used here, so an audience-scoped token cannot be lifted and
    // replayed against the rest of the API. Exempt the in-process self-dispatch
    // that already cleared a resource boundary inbound (invoke_operation).
    const resourceUris = listProtectedResourceUris();
    const boundToResource = audiences.some(
      (a) => typeof a === "string" && resourceUris.includes(a),
    );
    if (boundToResource && !isInternalDispatch(c.req.raw.headers)) {
      throw unauthorized(
        "Access token is bound to a different resource and cannot be used on this route.",
      );
    }
    return next();
  };
}
