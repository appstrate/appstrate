// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError, forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import {
  validateSpaceInOrg,
  type SpaceAccessSnapshot,
  type SpaceContextRow,
} from "../lib/space-lookup.ts";
import { setSpaceContextApplier } from "@appstrate/core/permissions";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  callerSpaceAccess,
  callerSpaceAccessById,
  effectiveInSpace,
} from "../lib/view-as.ts";
import { resolveSpaceRole } from "../lib/space-role.ts";

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
 * Resolve the caller's role in `space` and rewrite `permissions` to the
 * effective set there (RBAC spec §4.2). Exported so routers outside
 * `SPACE_SCOPED_PREFIXES` (the spaces router, module routes) reach the same
 * path. The principal is `c.get("user")`: the API key's CREATOR under key auth
 * and end-user impersonation, the subject otherwise (§7.1). An `end_user`
 * principal without an org role (OIDC end-user token) keeps its strategy's
 * fixed allowlist (§7.2); under API-key impersonation it carries the creator's
 * role and resolves like the key.
 *
 * Sets `c.set("space")`: the row judged with the caller's membership (§4.4),
 * not the lookup that found the space.
 *
 * @throws ApiError 403 `not_a_space_member` for `open`/`closed`, 404 for
 *   `private` — a private space does not exist for someone who is not in it.
 */
export async function applySpacePermissions(
  c: Context<AppEnv>,
  found: SpaceContextRow,
): Promise<void> {
  const space = await admitSpace(c, found);
  c.set("space", space);
}

/**
 * Enter a space by id: one read. A caller with an org role gets the lookup and its
 * membership as one snapshot (`callerSpaceAccessById`); an end-user token reads the row alone.
 */
export async function enterSpaceById(
  c: Context<AppEnv>,
  spaceId: string,
  orgId: string,
): Promise<void> {
  if (!c.get("orgRole")) {
    const space = await validateSpaceInOrg(spaceId, orgId);
    if (!space) throw spaceNotFound(spaceId);
    await applySpacePermissions(c, space);
    return;
  }
  const access = await callerSpaceAccessById(c, spaceId, orgId);
  if (!access) throw spaceNotFound(spaceId);
  c.set("space", await admitSpace(c, access.space, access));
}

/** Missing, another org's, private: one answer, so a 404 never confirms an id exists. */
function spaceNotFound(spaceId: string): ApiError {
  return notFound(`Space '${spaceId}' not found in this organization`);
}

async function admitSpace(
  c: Context<AppEnv>,
  space: SpaceContextRow,
  preloaded?: Pick<SpaceAccessSnapshot, "space" | "member">,
): Promise<SpaceContextRow> {
  // An end-user belongs to a space, never to a person (RBAC spec §3.6): a
  // personal space is a 404 for it whatever else it carries.
  if (c.get("principalKind") === "end_user" && space.ownerUserId !== null) {
    throw spaceNotFound(space.id);
  }
  if (!c.get("orgRole")) {
    // Only an end-user token resolves without an org role — its strategy's
    // fixed allowlist is the whole answer (§7.2). Anything else here is a
    // pipeline bug, not a caller to accommodate.
    if (c.get("principalKind") !== "end_user") {
      throw new Error(
        `applySpacePermissions: ${c.get("principalKind")} principal reached a space with no org role`,
      );
    }
    return space;
  }

  // Under a preview both halves are the persona's, and so is the caller id:
  // `callerPersonalOwnerId` answers `null` under a preview — a persona owns no
  // personal space — so a previewed request reaches none (RBAC spec §3.6), and
  // `visibility = 'private'` means the refusal below is a 404.
  const access = preloaded ?? (await callerSpaceAccess(c, space));
  if (!access) throw spaceNotFound(space.id);
  const ref = resolveSpaceRole(
    callerOrgRole(c, space.orgId),
    access.space,
    access.member,
    callerPersonalOwnerId(c, space.orgId),
  );
  if (!ref) {
    if (access.space.visibility === "private") throw spaceNotFound(space.id);
    throw new ApiError({
      status: 403,
      code: "not_a_space_member",
      title: "Not a Space Member",
      detail: `You are not a member of space '${space.id}'`,
    });
  }

  c.set("spaceRole", ref);
  c.set("permissions", effectiveInSpace(c, ref));
  return access.space;
}

/**
 * Middleware: resolve space context for space-scoped routes.
 *
 * Resolution order (transport-agnostic, symmetric with `requireOrgContext`):
 * 1. spaceId already pinned by an auth strategy (API key, OIDC JWT, …)
 * 2. X-Space-Id header (session auth, and every in-process re-entry)
 *
 * If a strategy already pinned a space and the request also carries
 * an `X-Space-Id` header, the header MUST match the pinned value. Otherwise
 * a holder of a Bearer token scoped to Space A could spoof `X-Space-Id: Space B`
 * (same org) and reach a second space's data. Session callers never
 * pin a space, so their header is still honoured as the primary
 * signal.
 *
 * There is no default-space fallback: a caller that names no space gets a 400,
 * never a silent landing on the default space. The in-process re-entries (MCP
 * dispatch, chat loopback) forward the space they entered.
 * Validates that the space belongs to the current org. Sets
 * c.set("spaceId"), and the admission sets c.set("space"), on success.
 */
export function requireSpaceContext() {
  return async (c: Context<AppEnv>, next: Next) => {
    const pinned = c.get("spaceId");
    const headerSpace = c.req.header("X-Space-Id");

    if (pinned && headerSpace && headerSpace !== pinned) {
      throw forbidden("X-Space-Id does not match authenticated space");
    }

    const explicitSpace = pinned ?? headerSpace;
    if (!explicitSpace) {
      throw invalidRequest(
        "Space context required. Provide X-Space-Id header or use an API key.",
        "X-Space-Id",
      );
    }
    await enterSpaceById(c, explicitSpace, c.get("orgId"));
    c.set("spaceId", explicitSpace);
    return next();
  };
}

/**
 * Wire the core seam a module route uses to enter a space (`enterSpaceContext`).
 * Registered at MODULE EVALUATION so production wiring and the test harness,
 * which both import `requireSpaceContext` from here, cannot drift.
 */
setSpaceContextApplier(async (c, spaceId) => {
  const ctx = c as Context<AppEnv>;
  const orgId = ctx.get("orgId");
  const explicit = spaceId ?? ctx.get("spaceId") ?? ctx.req.header("X-Space-Id");
  // Same rule as `requireSpaceContext`: a module route is not a weaker door
  // than a core one (`SPACES.md` §Resolving).
  if (!explicit) {
    throw invalidRequest(
      "Space context required. Provide X-Space-Id header or use an API key.",
      "X-Space-Id",
    );
  }
  // Deliberately does NOT write `spaceId`: that key is the CREDENTIAL's space
  // for an API key and a module must not be able to rewrite it (the webhooks
  // module compares the two to refuse a key reaching a sibling space).
  return enterSpaceById(ctx, explicit, orgId);
});
