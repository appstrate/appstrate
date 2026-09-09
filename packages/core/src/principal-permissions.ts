// SPDX-License-Identifier: Apache-2.0

/**
 * Extra org-level permissions for ONE user in ONE org, without an org role — an org
 * role named `billing` would put billing vocabulary in an Apache-2.0 enum.
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4.2, §10
 */

import { createCache } from "./cache.ts";
import { createLogger } from "./logger.ts";

const log = createLogger(process.env.LOG_LEVEL ?? "info");

export interface PrincipalPermissionContext {
  orgId: string;
  userId: string;
}

/** The `AppstrateModule.principalPermissions` shape. */
export interface ModulePrincipalPermissions {
  /**
   * Every org-level string this module may ever grant; validated at boot, and a resolver
   * answer outside it is dropped (a buggy module cannot widen its reach past boot review).
   */
  mayGrant: readonly string[];
  /** Called once per session request on a cache miss — keep it to one indexed lookup. */
  resolve(ctx: PrincipalPermissionContext): Promise<readonly string[]>;
}

/** One declaration, as the platform registers it after validation. */
export interface RegisteredPrincipalPermissions extends ModulePrincipalPermissions {
  /** Named in the drop and failure log lines. */
  moduleId: string;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Same 10s as the org-settings cache: the bus invalidates, the TTL only bounds a LOST broadcast. */
const TTL_MS = 10_000;

/** `orgId:userId` → the filtered union. */
const cache = createCache<ReadonlySet<string>>({
  name: "principal-permissions",
  ttlMs: TTL_MS,
  max: 5_000,
});

let providers: readonly RegisteredPrincipalPermissions[] = [];

/** Warned pairs, so a hot path logs once. */
const warned = new Set<string>();

const keyOf = (orgId: string, userId: string): string => `${orgId}:${userId}`;

/** Platform boot wiring. Re-registering drops the cache, whose answers came from other declarations. */
export function setPrincipalPermissionsProviders(
  registered: readonly RegisteredPrincipalPermissions[] | null,
): void {
  providers = registered ?? [];
  warned.clear();
  cache.clear();
}

/**
 * Union over every declaring module, each answer filtered to its own `mayGrant`.
 * With none (the OSS baseline) the cache is never touched.
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
 * Drop one principal's grants on all replicas. The granting module calls this
 * from its own writes; the platform cannot know when a module's table changed.
 */
export function invalidatePrincipalPermissions(orgId: string, userId: string): void {
  cache.invalidate(keyOf(orgId, userId));
}
