// SPDX-License-Identifier: Apache-2.0

/**
 * Per-principal org-level grants — the module surface that gives ONE user in
 * ONE org extra org-level permissions, without inventing an org role for them
 * (RBAC spec §4.2, §10).
 *
 * The motivating case is a billing manager: someone who may act on billing
 * without being an org admin. `billing` is a cloud concept and an org role
 * named after it would put billing vocabulary in an Apache-2.0 enum, so the
 * grant attaches to the principal instead of to the role. SSO group mapping is
 * the next consumer of the same surface.
 *
 * Three properties are deliberate:
 *
 *  - **Declared, then filtered.** A module states up front which strings it may
 *    ever grant (`mayGrant`, validated at boot by the platform's module
 *    loader). Anything else its resolver returns at runtime is dropped, not
 *    granted — a buggy module cannot widen its own reach past what boot review
 *    saw.
 *  - **Session-only by construction.** The platform refuses a `mayGrant` entry
 *    that is API-key- or end-user-grantable, and evaluates the surface for
 *    session-shaped callers only. A delegated credential's ceiling can
 *    therefore never carry a principal grant.
 *  - **Isolated failures.** A throwing resolver contributes nothing and is
 *    logged; it never fails the request. A billing outage must not lock every
 *    admin out of their organization.
 *
 * Results are cached per `(orgId, userId)` on the platform's one cache
 * primitive, so the surface costs a single lookup per principal per TTL rather
 * than one per request. Invalidation is the granting module's job — it alone
 * knows when its own table changed — through
 * {@link invalidatePrincipalPermissions}, which drops the entry on every
 * replica through the cache bus.
 */

import { createCache } from "./cache.ts";
import { createLogger } from "./logger.ts";

const log = createLogger(process.env.LOG_LEVEL ?? "info");

/** Who the grants are being resolved for. */
export interface PrincipalPermissionContext {
  orgId: string;
  userId: string;
}

/**
 * The `AppstrateModule.principalPermissions` shape — a module's declaration
 * that it grants org-level permissions per principal.
 */
export interface ModulePrincipalPermissions {
  /**
   * Every org-level string this module may ever grant. Validated at boot
   * against the core org-level catalog union the module's own `level: "org"`
   * contributions; an API-key- or end-user-grantable entry is refused there,
   * because those ceilings can never carry a session-only grant.
   */
  mayGrant: readonly string[];
  /**
   * Extra org-level permissions for one principal. Called once per session
   * request on a cache miss — keep it to one indexed lookup.
   */
  resolve(ctx: PrincipalPermissionContext): Promise<readonly string[]>;
}

/** One loaded module's declaration, as the platform registers it after validation. */
export interface RegisteredPrincipalPermissions extends ModulePrincipalPermissions {
  /** The declaring module's id — named in the drop and failure log lines. */
  moduleId: string;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * TTL. The same 10s the org-settings cache uses, for the same reason: this is
 * authorization-shaped per-org state whose real invalidation is the bus, and
 * the TTL only bounds how long a LOST broadcast can leave a replica stale.
 * Longer widens that window on a permission set; shorter spends a query per
 * principal per request for coherence the bus already gives.
 */
const TTL_MS = 10_000;

/** `orgId:userId` → the union, already filtered to each module's `mayGrant`. */
const cache = createCache<ReadonlySet<string>>({
  name: "principal-permissions",
  ttlMs: TTL_MS,
  max: 5_000,
});

let providers: readonly RegisteredPrincipalPermissions[] = [];

/** `moduleId permission` pairs already warned about, so a hot path logs once. */
const warned = new Set<string>();

const keyOf = (orgId: string, userId: string): string => `${orgId}:${userId}`;

/**
 * Register (or clear, with `null`) the modules that grant per-principal
 * permissions. Called once at boot by the platform's module loader, after it
 * has validated every declared `mayGrant`. Re-registering replaces the set and
 * drops the cache — the cached answers were computed from other declarations.
 */
export function setPrincipalPermissionsProviders(
  registered: readonly RegisteredPrincipalPermissions[] | null,
): void {
  providers = registered ?? [];
  warned.clear();
  cache.clear();
}

/**
 * Extra org-level permissions this principal holds: the union over every
 * module declaring the surface, each module's answer filtered to its own
 * `mayGrant`.
 *
 * With no module declaring it — the OSS baseline — this returns the shared
 * empty set without touching the cache at all, so the zero-footprint invariant
 * holds down to the allocation.
 */
export async function resolvePrincipalPermissions(
  ctx: PrincipalPermissionContext,
): Promise<ReadonlySet<string>> {
  if (providers.length === 0) return EMPTY;
  return cache.get(keyOf(ctx.orgId, ctx.userId), () => loadPrincipalPermissions(ctx));
}

async function loadPrincipalPermissions(
  ctx: PrincipalPermissionContext,
): Promise<ReadonlySet<string>> {
  const granted = new Set<string>();
  for (const provider of providers) {
    let answered: readonly string[];
    try {
      answered = await provider.resolve(ctx);
    } catch (err) {
      log.error("principal permissions: resolver failed", {
        module: provider.moduleId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const permission of answered) {
      if (!provider.mayGrant.includes(permission)) {
        warnUndeclared(provider.moduleId, permission);
        continue;
      }
      granted.add(permission);
    }
  }
  return granted;
}

function warnUndeclared(moduleId: string, permission: string): void {
  const seen = `${moduleId} ${permission}`;
  if (warned.has(seen)) return;
  warned.add(seen);
  log.warn("principal permissions: dropped an undeclared grant", {
    module: moduleId,
    permission,
    reason: "not listed in mayGrant",
  });
}

/**
 * Drop the cached grants for one principal, or for every principal of `orgId`
 * when `userId` is omitted — locally and, through the cache bus, on every
 * replica. The granting module calls this from its own writes; the platform
 * cannot know when a module's table changed.
 *
 * The org-wide form clears the whole cache rather than a key prefix: the
 * primitive is keyed, not prefixed, and a membership write of this kind is
 * rare enough that re-warming each principal costs one lookup.
 */
export function invalidatePrincipalPermissions(orgId: string, userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.invalidate(keyOf(orgId, userId));
}
