// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { ApiError, forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import { assertSpaceId } from "../lib/ids.ts";
import { isInternalDispatch } from "../lib/internal-dispatch.ts";
import { setSpaceContextApplier } from "@appstrate/core/permissions";
import { effectivePermissions } from "../lib/permissions.ts";
import { loadSpaceMember, resolveSpaceRole, spacePermissions } from "../lib/space-role.ts";

/**
 * Core route prefixes that require a space context (`X-Space-Id`,
 * or the API key's own `spaceId`).
 *
 * Core-only by design: modules own space-scoping for their own routes (the
 * webhooks module, for instance, gates on an explicit `spaceId` body /
 * query field), so a module never adds a row here.
 *
 * This list is read by the space-context middleware wiring in BOTH
 * `apps/api/src/index.ts` and the test harness `apps/api/test/helpers/app.ts`.
 * It lived as two hand-kept copies until they were reconciled here — a route
 * family added to one and not the other gives a test app whose space-scoping
 * differs from production, which is exactly the kind of gap tests exist to
 * close.
 *
 * Deliberately NOT exported: `isSpaceScopedPath` below is the only reader, and
 * it is what both call sites import. Handing out the array would let a caller
 * re-derive the predicate (`.some(startsWith)`) its own way, which is the
 * shape the drift took the first time.
 */
const SPACE_SCOPED_PREFIXES = [
  "/api/agents",
  "/api/runs",
  "/api/schedules",
  "/api/end-users",
  "/api/api-keys",
  "/api/notifications",
  "/api/packages",
  "/api/integrations",
  "/api/uploads",
  "/api/files",
] as const;

/** True when `path` belongs to a core space-scoped route family. */
export function isSpaceScopedPath(path: string): boolean {
  return SPACE_SCOPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Resolved space row exposed on the Hono context under `c.get("space")`.
 * Carries the fields every space-scoped route currently needs — keep the set
 * tight so downstream services can destructure without re-reading the row.
 */
export interface SpaceContextRow {
  id: string;
  orgId: string;
  isDefault: boolean;
  visibility: import("@appstrate/core/permissions").SpaceVisibility;
  defaultRole: import("@appstrate/core/permissions").SpaceRolePreset;
}

/** Projection behind {@link SpaceContextRow} — declared once so the two readers cannot drift. */
const SPACE_CONTEXT_COLUMNS = {
  id: spaces.id,
  orgId: spaces.orgId,
  isDefault: spaces.isDefault,
  visibility: spaces.visibility,
  defaultRole: spaces.defaultRole,
} as const;

/**
 * Validate that a space belongs to the given org.
 * Returns the full `SpaceContextRow` or null if not found.
 * Shared by the space-context middleware, SSE auth and the MCP router — this is
 * where a CLIENT-SUPPLIED space id enters, which is why the id-shape guard
 * lives here rather than at each of those call sites.
 *
 * It is NOT the only entry point, and the guard is not only here. Three paths
 * take a space id from a row instead of from the request and so skip this
 * function entirely; each asserts the shape itself, and each says so at the
 * call site:
 *   - `requireSpaceContext`'s default-space fallback (below)
 *   - `resolveMcpSpaceScope`'s default-space fallback (`modules/mcp/router.ts`)
 *   - `validateSSEAuth`'s API-key branch (`routes/realtime.ts`)
 *
 * The shape check runs BEFORE the SELECT on purpose. A `spc_` id that does not
 * exist is a 404 (`null`); a retired `app_` id is not a missing row, it is
 * un-migrated data or an un-migrated caller, and `assertSpaceId` throws with a
 * message that says so. Without it a half-run migration is silent: header, API
 * key and `spaces` row would all still hold `app_` and agree with each other.
 */
export async function validateSpaceInOrg(
  spaceId: string,
  orgId: string,
): Promise<SpaceContextRow | null> {
  assertSpaceId(spaceId);
  const [space] = await db
    .select(SPACE_CONTEXT_COLUMNS)
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)))
    .limit(1);
  return space ?? null;
}

/**
 * The org's default space (`is_default = true`). Used as the last-resort
 * fallback for header-less MCP callers — see `requireSpaceContext` and the MCP
 * router's per-session space-scope resolution.
 */
export async function defaultSpaceForOrg(orgId: string): Promise<SpaceContextRow | null> {
  const [space] = await db
    .select(SPACE_CONTEXT_COLUMNS)
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.isDefault, true)))
    .limit(1);
  return space ?? null;
}

/**
 * Resolve the caller's role in `space` and rewrite `permissions` to the
 * effective set there (RBAC spec §4.2).
 *
 * Exported because a router outside `SPACE_SCOPED_PREFIXES` — the spaces
 * router itself, or a module gating a space-level resource off an explicit
 * `spaceId` field — must reach the same code path; otherwise its guard can
 * never pass for a non-admin.
 *
 * The principal whose membership is resolved is `c.get("user")`, which is the
 * API key's **creator** under key auth and under end-user impersonation (the
 * key's own row is what the pipeline resolved), and the subject under a
 * session or dashboard token (RBAC spec §7.1).
 *
 * A caller whose `orgRole` was never resolved keeps whatever set its auth
 * strategy wrote: an OIDC end-user token carries a fixed allowlist and no org
 * role, and end-users are never space members (§7.2).
 *
 * @throws ApiError 403 `not_a_space_member` for `open`/`closed`, 404 for
 *   `private` — a private space does not exist for someone who is not in it.
 */
export async function applySpacePermissions(
  c: Context<AppEnv>,
  space: SpaceContextRow,
): Promise<void> {
  const orgRole = c.get("orgRole");
  if (!orgRole) return;

  const memberRow = await loadSpaceMember(space.id, c.get("user").id);
  const ref = resolveSpaceRole(orgRole, space, memberRow);
  if (!ref) {
    if (space.visibility === "private") {
      throw notFound(`Space '${space.id}' not found in this organization`);
    }
    throw new ApiError({
      status: 403,
      code: "not_a_space_member",
      title: "Not a Space Member",
      detail: `You are not a member of space '${space.id}'`,
    });
  }

  c.set("spaceRole", ref);
  c.set(
    "permissions",
    effectivePermissions({
      orgPermissions: c.get("orgPermissions") ?? new Set<string>(),
      spacePermissions: spacePermissions(ref),
      scopeCeiling: c.get("scopeCeiling"),
    }),
  );
}

/**
 * Middleware: resolve space context for space-scoped routes.
 *
 * Resolution order (transport-agnostic, symmetric with `requireOrgContext`):
 * 1. spaceId already pinned by an auth strategy (API key, OIDC JWT, …)
 * 2. X-Space-Id header (session auth — dashboard users)
 * 3. the org's default space
 *
 * If a strategy already pinned a space and the request also carries
 * an `X-Space-Id` header, the header MUST match the pinned value. Otherwise
 * a holder of a Bearer token scoped to Space A could spoof `X-Space-Id: Space B`
 * (same org) and reach a second space's data. Session callers never
 * pin a space, so their header is still honoured as the primary
 * signal.
 *
 * The default-space fallback exists SOLELY for the in-process MCP sub-dispatch: a
 * per-org MCP Bearer token pins the org but reaches a space-scoped route via an
 * in-process re-entry carrying NO `X-Space-Id`, so it resolves to the
 * org's default space. That re-entry is identified by the trusted
 * internal-dispatch marker (an unguessable per-process secret, stripped from
 * any client-supplied copy), so the fallback is gated on it. A direct caller —
 * session/SPA or CLI — that omits `X-Space-Id` still gets a 400, NOT a
 * silent fallback to the default space (which would weaken space isolation and is
 * exactly the contract `org-isolation` asserts).
 * Validates that the space belongs to the current org. Sets
 * c.set("spaceId") + c.set("space") on success.
 */
export function requireSpaceContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const pinned = c.get("spaceId");
    const headerSpace = c.req.header("X-Space-Id");

    if (pinned && headerSpace && headerSpace !== pinned) {
      throw forbidden("X-Space-Id does not match authenticated space");
    }

    const orgId = c.get("orgId");
    const explicitSpace = pinned ?? headerSpace;

    if (explicitSpace) {
      const space = await validateSpaceInOrg(explicitSpace, orgId);
      if (!space) {
        throw notFound(`Space '${explicitSpace}' not found in this organization`);
      }
      c.set("spaceId", explicitSpace);
      c.set("space", space);
      await applySpacePermissions(c, space);
      return next();
    }

    // Header-less caller. The org's default-space fallback is reserved
    // for the trusted in-process MCP re-entry (marker present); every other
    // header-less caller must supply an explicit space.
    if (isInternalDispatch(c.req.raw.headers)) {
      const active = await defaultSpaceForOrg(orgId);
      if (active) {
        // One of the three paths that never pass through `validateSpaceInOrg`
        // (the others: the MCP router's default-space fallback and the SSE
        // API-key branch — see the note on `validateSpaceInOrg`). The id comes
        // straight off the row, so this is where an un-migrated `spaces` table
        // would otherwise slip in unnoticed.
        assertSpaceId(active.id);
        c.set("spaceId", active.id);
        c.set("space", active);
        // The in-process MCP re-entry lands on the default space; the token
        // subject's membership there decides what it reaches — every `member`
        // is implicit, a `guest` without a row is refused (spec §7.3).
        await applySpacePermissions(c, active);
        return next();
      }
    }

    throw invalidRequest(
      "Space context required. Provide X-Space-Id header or use an API key.",
      "X-Space-Id",
    );
  };
}

/**
 * Wire the core seam a module route uses to enter a space
 * (`enterSpaceContext`, `@appstrate/core/permissions`).
 *
 * Registered at MODULE EVALUATION, not from a boot function: both the
 * production wiring (`apps/api/src/index.ts`) and the test harness
 * (`apps/api/test/helpers/app.ts`) import `requireSpaceContext` from this file,
 * so the registration cannot be present in one and missing in the other — the
 * exact drift a second wiring call site would reintroduce.
 */
setSpaceContextApplier(async (c, spaceId) => {
  const ctx = c as Context<AppEnv>;
  const orgId = ctx.get("orgId");
  const explicit = spaceId ?? ctx.get("spaceId") ?? ctx.req.header("X-Space-Id");
  const space = explicit
    ? await validateSpaceInOrg(explicit, orgId)
    : await defaultSpaceForOrg(orgId);
  if (!space) {
    throw notFound(`Space '${explicit ?? "(default)"}' not found in this organization`);
  }
  // Deliberately does NOT write `spaceId`: that key is the CREDENTIAL's space
  // for an API key, and a module naming another space must not be able to
  // rewrite it — the webhooks module compares the two to refuse a key reaching
  // a sibling space. `space` and `permissions` are what entering a space means.
  ctx.set("space", space);
  await applySpacePermissions(ctx, space);
});
