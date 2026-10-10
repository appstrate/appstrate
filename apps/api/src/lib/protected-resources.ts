// SPDX-License-Identifier: Apache-2.0

/**
 * Generic protected-resource registry + RFC 8707 audience confinement.
 *
 * A "protected resource" is an OAuth resource server mounted inside the
 * platform that issues audience-bound access tokens (RFC 8707) — currently the
 * inbound MCP server's per-org and per-space endpoints (`/api/mcp/o/:org`,
 * `/api/mcp/o/:org/s/:space`, registered as one dynamic family since there is
 * one resource URI per org and per space). A spec-compliant client obtains a
 * token whose `aud` is that resource's canonical URI, and the resource MUST
 * reject tokens not issued for it (MCP authorization spec, 2025-11-25).
 *
 * This registry keeps the audience rule in ONE place instead of special-casing
 * paths inside the shared auth pipeline (mirrors `auth-challenges.ts`). A
 * resource family registers its path prefix once; `enforceResourceAudience`
 * then enforces both halves of audience binding for every bearer token:
 *
 * - **Inbound** — a request to a registered resource must present a token whose
 *   `aud` includes that resource's URI or a URI enclosing it (a space endpoint
 *   accepts its organization's token), else 401.
 * - **Outbound** — a token whose `aud` is bound to a registered resource may
 *   NOT be used on any route OUTSIDE a resource. This stops an audience-scoped
 *   token (e.g. an MCP client's, which carries the connecting user's full
 *   authority) from being lifted and replayed against the rest of the REST API.
 *   The one legitimate exception is an in-process self-dispatch that already
 *   cleared a resource boundary inbound (`invoke_operation`), identified by the
 *   unforgeable internal-dispatch marker.
 *
 * The registry also lets the authorization server ask a family to make a
 * resource mintable (`ensureProtectedResourcesMintable`) before it resolves a
 * requested `resource` against its persisted rows.
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
 * enumerated at registration time (e.g. the inbound MCP server's per-org and
 * per-space endpoints, created at runtime). The family owns the whole `prefix`
 * sub-tree:
 *
 * - `deriveUri(path)` maps a concrete request path under the family to its
 *   canonical resource URI, or `undefined` when the path is under the prefix but
 *   is NOT a real resource (e.g. a malformed/incomplete sub-path) — in which
 *   case the family does not match and the request is treated as non-resource.
 * - `ownsUri(uri)` is the inverse direction: whether a given audience URI
 *   belongs to this family (for outbound confinement / mint-time checks), without
 *   needing a request path. It must accept exactly the URIs `deriveUri` can emit.
 */
interface ProtectedResourceFamily {
  prefix: string;
  deriveUri(path: string): string | undefined;
  ownsUri(uri: string): boolean;
  /** Resources enclosing `uri` whose tokens it also accepts (a space endpoint accepts its org's token). */
  enclosingUris?(uri: string): readonly string[];
  /** Write what the AS needs to mint `uri` (its oauth_resources row) when it names a live resource; no-op otherwise. */
  ensureMintable?(uri: string): Promise<void>;
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
 * treated as non-resource. `accepted` is the resource URI followed by the URIs
 * enclosing it: the audiences a token may carry to reach it.
 */
export function resolveProtectedResource(
  path: string,
): { prefix: string; uri: string; accepted: readonly string[] } | undefined {
  for (const family of families) {
    if (path !== family.prefix && !path.startsWith(`${family.prefix}/`)) continue;
    const uri = family.deriveUri(path);
    if (uri) {
      return {
        prefix: family.prefix,
        uri,
        accepted: [uri, ...(family.enclosingUris?.(uri) ?? [])],
      };
    }
  }
  return undefined;
}

/**
 * Whether `uri` is a protected-resource URI — true if owned by any registered
 * family (`ownsUri`). This is the audience-side counterpart of
 * `resolveProtectedResource` (which works from a request path): it answers "is
 * this token audience bound to ANY protected resource?" without enumerating the
 * (dynamic) family URIs — the MCP resources cannot be listed at mint
 * time. Backs the outbound-confinement gate and the self-service single-resource
 * rule at the token endpoint.
 */
export function isProtectedResourceUri(uri: string): boolean {
  return families.some((f) => f.ownsUri(uri));
}

/**
 * Called by the authorization server before it resolves the requested
 * `resource` values against its persisted rows: each URI's owning family (the
 * first whose `ownsUri` accepts it) writes what minting it needs. URIs no family
 * owns are left to the AS (`invalid_target` when it has no row).
 */
export async function ensureProtectedResourcesMintable(uris: readonly string[]): Promise<void> {
  for (const uri of uris) {
    const family = families.find((f) => f.ownsUri(uri));
    await family?.ensureMintable?.(uri);
  }
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

    // Inbound: a request to a protected resource must carry that resource, or
    // one enclosing it, in its audience (RFC 8707 / RFC 9728 / MCP MUST). The
    // auth-challenge responder turns this 401 into a WWW-Authenticate so the
    // client can re-acquire a correctly-scoped token.
    if (target) {
      if (!audiences.some((a) => typeof a === "string" && target.accepted.includes(a))) {
        throw unauthorized(
          `Access token is not audience-bound to this resource (${target.prefix}).`,
        );
      }
      // A token may bind to at most ONE protected resource. Reject one that
      // carries a second protected-resource URI (another org's endpoint, or an
      // org and one of its spaces) so cross-resource confinement is enforced
      // here, by the audience layer itself, rather than relying on a downstream
      // guard. Self-service tokens are already capped at one resource at mint
      // time; this closes the first-party multi-resource case too.
      const boundResources = new Set(
        audiences.filter((a) => typeof a === "string" && isProtectedResourceUri(a)),
      );
      if (boundResources.size > 1) {
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
    // `isProtectedResourceUri` covers the dynamic families (e.g. the MCP
    // resource URIs) without enumerating them.
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
