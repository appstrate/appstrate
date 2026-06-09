// SPDX-License-Identifier: Apache-2.0

/**
 * Generic protected-resource registry + RFC 8707 audience confinement.
 *
 * A "protected resource" is an OAuth resource server mounted inside the
 * platform that issues audience-bound access tokens (RFC 8707) — currently the
 * inbound MCP server's per-org endpoints (`/api/mcp/o/:org`, registered as a
 * dynamic family since there is one resource URI per org). A spec-compliant
 * client obtains a token whose `aud` is that resource's canonical URI, and the
 * resource MUST reject tokens not issued for it (MCP authorization spec,
 * 2025-11-25).
 *
 * This registry generalises that contract so the audience rule lives in ONE
 * place instead of being special-cased per path inside the shared auth
 * pipeline (mirrors `auth-challenges.ts`). A resource family registers its path
 * prefix once; `enforceResourceAudience` then enforces both halves of audience
 * binding for every bearer token:
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

/**
 * A FAMILY of protected resources sharing a path prefix but with a per-request
 * resource URI — used when the concrete resources are dynamic and cannot be
 * enumerated at registration time (e.g. the inbound MCP server's per-org
 * endpoints `/api/mcp/o/:org`, one URI per organization, orgs created at
 * runtime). The family owns the whole `prefix` sub-tree:
 *
 * - `deriveUri(path)` maps a concrete request path under the family to its
 *   canonical resource URI, or `undefined` when the path is under the prefix but
 *   is NOT a real resource (e.g. a malformed/incomplete sub-path) — in which
 *   case the family does not match and the request is treated as non-resource.
 * - `ownsUri(uri)` is the inverse direction: whether a given audience URI
 *   belongs to this family (for outbound confinement / mint-time checks), without
 *   needing a request path. It must accept exactly the URIs `deriveUri` can emit.
 */
export interface ProtectedResourceFamily {
  prefix: string;
  deriveUri(path: string): string | undefined;
  ownsUri(uri: string): boolean;
}

const families: ProtectedResourceFamily[] = [];

/**
 * Register a protected-resource FAMILY (see `ProtectedResourceFamily`).
 * Idempotent per prefix (re-registering replaces — safe across test-harness
 * module reloads). Matched longest-prefix-first so a more specific resource
 * wins over a broader one.
 */
export function registerProtectedResourceFamily(family: ProtectedResourceFamily): void {
  const existing = families.findIndex((f) => f.prefix === family.prefix);
  if (existing >= 0) families[existing] = family;
  else families.push(family);
  families.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Test-only: clear the registry between cases. */
export function resetProtectedResources(): void {
  families.length = 0;
}

/**
 * Test-only: snapshot/restore the registry. Same rationale as
 * `snapshotAuthChallenges` — the families registry is a process-wide singleton
 * the live app populates once (when a module's router is built). A unit test
 * that resets it must restore the prior contents (`beforeAll`/`afterAll`) so it
 * does not wipe the app's registration for later test files in the same
 * process, making cross-file order irrelevant.
 */
export function snapshotProtectedResources(): readonly ProtectedResourceFamily[] {
  return families.slice();
}
export function restoreProtectedResources(snapshot: readonly ProtectedResourceFamily[]): void {
  families.length = 0;
  families.push(...snapshot);
}

/**
 * The resource whose prefix matches `path`, if any (longest-prefix-first). A
 * family matches only when `path` is under its prefix AND `deriveUri(path)`
 * returns a URI — a family that owns the path space but cannot derive a URI for
 * this particular path (malformed sub-path) does NOT match, so the path is
 * treated as non-resource.
 */
export function resolveProtectedResource(
  path: string,
): { prefix: string; uri: string } | undefined {
  for (const family of families) {
    if (path !== family.prefix && !path.startsWith(`${family.prefix}/`)) continue;
    const uri = family.deriveUri(path);
    if (uri) return { prefix: family.prefix, uri };
  }
  return undefined;
}

/**
 * Whether `uri` is a protected-resource URI — true if owned by any registered
 * family (`ownsUri`). This is the audience-side counterpart of
 * `resolveProtectedResource` (which works from a request path): it answers "is
 * this token audience bound to ANY protected resource?" without enumerating the
 * (dynamic) family URIs — the per-org MCP resources cannot be listed at mint
 * time. Backs the outbound-confinement and mint-time gates.
 */
export function isProtectedResourceUri(uri: string): boolean {
  return families.some((f) => f.ownsUri(uri));
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
      // A token may bind to at most ONE protected resource. Reject one that
      // ALSO carries a different protected-resource URI (e.g. a second org's
      // per-org MCP endpoint) so cross-resource confinement is enforced here, by
      // the audience layer itself, rather than relying on a downstream per-
      // resource guard (the per-org MCP router pins the first audience and
      // 403s a mismatch, but that is a backstop, not the boundary). Self-service
      // tokens are already capped at one resource at mint time; this closes the
      // first-party multi-resource case too.
      const foreignResource = audiences.find(
        (a) => typeof a === "string" && a !== target.uri && isProtectedResourceUri(a),
      );
      if (foreignResource) {
        throw unauthorized(
          "Access token is bound to more than one protected resource; it may target only one.",
        );
      }
      return next();
    }

    // Outbound: this route is not a protected resource. A token bound to one
    // may not be used here, so an audience-scoped token cannot be lifted and
    // replayed against the rest of the API. Exempt the in-process self-dispatch
    // that already cleared a resource boundary inbound (invoke_operation).
    // `isProtectedResourceUri` covers the dynamic families (e.g. the per-org
    // MCP resource URIs) without enumerating them.
    const boundToResource = audiences.some(
      (a) => typeof a === "string" && isProtectedResourceUri(a),
    );
    if (boundToResource && !isInternalDispatch(c.req.raw.headers)) {
      throw unauthorized(
        "Access token is bound to a different resource and cannot be used on this route.",
      );
    }
    return next();
  };
}
