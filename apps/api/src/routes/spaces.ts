// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { getPackageLibrary } from "../services/package-library.ts";
import type { Context, Next } from "hono";
import { z } from "zod";
import {
  makePermissionGuard,
  packagePermission,
  SPACE_ROLE_PRESETS,
  SPACE_VISIBILITIES,
  spacePackagePermission,
} from "@appstrate/core/permissions";
import type { SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import {
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
} from "@appstrate/core/model-generation";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { pinnedSpaceScopeGuard } from "../middleware/guards.ts";
import { ApiError, forbidden, invalidRequest, internalError, notFound } from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { getErrorMessage } from "@appstrate/core/errors";
import { listResponse } from "../lib/list-response.ts";
import { toISO } from "../lib/date-helpers.ts";
import {
  assertSpaceAdminAct,
  convertPersonalSpaceToTeam,
  createSpace,
  emptyAndDeletePersonalSpace,
  ensurePersonalSpaceFor,
  isSpaceVisibleTo,
  listSpacesForPrincipal,
  getSpace,
  updateSpace,
  deleteSpace,
  spaceSettingsSchema,
} from "../services/spaces.ts";
import {
  listSpaceMembers,
  removeSpaceMember,
  resolveOrgMemberEmail,
  saveSpaceMember,
} from "../services/space-members.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  callerSpaceAccess,
  effectiveInSpace,
  personaFor,
  personaMemberships,
} from "../lib/view-as.ts";
import { resolveSpaceRole, toSpaceRoleWire, type SpaceRoleRef } from "../lib/space-role.ts";
import { applySpacePermissions } from "../middleware/space-context.ts";
import { validateSpaceInOrg } from "../lib/space-lookup.ts";
import { isUserPrincipal } from "../lib/principal.ts";
import {
  activatePackage,
  deactivatePackage,
  listSpacePackages,
  getSpacePackage,
  getResolvedRunConfig,
  updatePlacementSettings,
} from "../services/space-packages.ts";
import { validateDomainList } from "../services/redirect-validation.ts";
import {
  assertCatalogPackageAccess,
  assertPackageShareAccess,
  isPackageReadableInSpace,
} from "../lib/package-access.ts";
import {
  markSpaceRescope,
  requireAnyPermission,
  requirePermission,
} from "../middleware/require-permission.ts";
import {
  auditSpaceRole,
  exactlyOneRole,
  spaceRoleAssignmentShape,
  toAssignment,
} from "../lib/space-role-assignment.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { SpaceSweepResult } from "@appstrate/shared-types";
import { recordAuditFromContext } from "../services/audit.ts";
import { listSpaceRoles } from "../services/space-roles.ts";
import { assertCanGrantSpaceRole, canGrantSpaceRole } from "../lib/space-role-policy.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import {
  assertExplicitModelExists,
  resolveModel,
  validateGenerationOverride,
} from "../services/org-models.ts";

/**
 * The wire shape every space response carries: the row plus the CALLER's
 * standing in it. `SpaceObject` requires all six, so a route that returned
 * only the row would answer a body its own contract refuses.
 *
 * `personal` replaces `owner_user_id` on the wire on purpose: the SPA needs to
 * know THAT a space is somebody's personal space (to pin it, to hide the
 * Members tab, to lock visibility), never whose — and it renders its own
 * translated label rather than the stored `"Mon espace"`. `orphaned_at` is
 * added only for owners and admins, the only callers who see an orphaned
 * personal space at all and the only ones with an act to perform on it
 * (RBAC spec §3.6).
 */
function spaceWireForCaller(
  c: Context<AppEnv>,
  space: {
    id: string;
    createdBy: string | null;
    visibility: SpaceVisibility;
    defaultRole: SpaceRolePreset;
    ownerUserId: string | null;
    orphanedAt: Date | null;
  },
  role: SpaceRoleRef | null,
) {
  const orgRole = callerOrgRole(c);
  const administers = orgRole === "owner" || orgRole === "admin";
  return {
    object: "space" as const,
    ...toSpaceWire(space),
    personal: space.ownerUserId !== null,
    ...(administers ? { orphaned_at: toISO(space.orphanedAt) } : {}),
    access: role ? ("member" as const) : ("none" as const),
    role: toSpaceRoleWire(role),
    permissions: [...effectiveInSpace(c, role)].sort(),
  };
}

/**
 * Project a Drizzle space row onto the wire shape. The DB columns are
 * `created_by` / `default_role`; the Drizzle TS fields are `createdBy` /
 * `defaultRole` and the wire contract (SpaceObject) is snake_case for both, so
 * both are renamed here. `ownerUserId` / `orphanedAt` are dropped and replaced
 * by what {@link spaceWireForCaller} computes from them.
 */
function toSpaceWire<
  T extends {
    createdBy: string | null;
    defaultRole: SpaceRolePreset;
    ownerUserId: string | null;
    orphanedAt: Date | null;
  },
>(
  space: T,
): Omit<T, "createdBy" | "defaultRole" | "ownerUserId" | "orphanedAt"> & {
  created_by: string | null;
  default_role: SpaceRolePreset;
} {
  const {
    createdBy,
    defaultRole,
    ownerUserId: _ownerUserId,
    orphanedAt: _orphanedAt,
    ...rest
  } = space;
  return { ...rest, created_by: createdBy, default_role: defaultRole };
}

/**
 * Who is acting, for {@link assertSpaceAdminAct}: the principal's
 * PERSONAL-SPACE identity, `null` for a principal that owns none.
 *
 * `callerPersonalOwnerId` and not `c.get("user").id`, because the question the
 * helper asks — "is this space the caller's own" — has to be answered the same
 * way here as on every other route. An API key carries its creator's authority
 * but not their privacy, so reading the creator's id made `DELETE` answer a
 * named 409 on the creator's personal space while every other route 404s on it.
 */
function callerFor(c: Context<AppEnv>) {
  return { userId: callerPersonalOwnerId(c), orgRole: callerOrgRole(c) };
}

export const createSpaceSchema = z
  .object({
    name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
    settings: spaceSettingsSchema.optional(),
  })
  .strict();

export const updateSpaceSchema = z
  .object({
    name: z
      .string()
      .min(1, "name is required")
      .max(100, "name must be 100 characters or less")
      .optional(),
    settings: spaceSettingsSchema.optional(),
    visibility: z.enum(SPACE_VISIBILITIES).optional(),
    default_role: z.enum(SPACE_ROLE_PRESETS).optional(),
  })
  .strict();

/** Exactly one user reference and one role assignment. */
export const addSpaceMemberSchema = exactlyOneRole(
  z.object({
    userId: z.string().min(1).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    ...spaceRoleAssignmentShape,
  }),
).refine((data) => (data.userId !== undefined) !== (data.email !== undefined), {
  message: "Provide exactly one of userId or email",
});

export const updateSpaceMemberSchema = exactlyOneRole(z.object({ ...spaceRoleAssignmentShape }));

// Neither body carries the agent's stored input values: `PUT
// /api/agents/{scope}/{name}/input-settings` is their single write path,
// because it is the only one that validates them against
// `manifest.input.schema` and enforces `assertLockedFieldsSatisfiable`.
export const activatePackageSchema = z
  .object({
    packageId: z.string().min(1),
  })
  .strict();

// No `version_id`: a placement carries no version. Which bytes a space runs is
// decided per launch — the published `latest`, or the draft for whoever can
// write the package — not frozen on the row.
//
// No `enabled` either: activation is its own act, with its own pair of doors
// (`POST` / `DELETE` on this collection), so the placement rule and the offer
// that may have to be created with it are stated once instead of twice. The
// schema is `.strict()`, so a body still sending either field is a 400 rather
// than a silent no-op.
export const updatePackageSchema = z
  .object({
    generation_config: modelGenerationSettingsSchema.nullable().optional(),
    modelId: z.string().nullable().optional(),
    proxyId: z.string().nullable().optional(),
    // Skills only: inject the published SKILL.md in every chat turn held here.
    chat_enforced: z.boolean().optional(),
  })
  .strict();

/**
 * Resolve the space named by a path param and apply the caller's permissions in
 * it, so a space-level guard downstream reads the right Set.
 *
 * `/api/spaces` is deliberately NOT in `SPACE_SCOPED_PREFIXES` — it is the
 * catalog route family, and its own listing must stay reachable without one
 * space being current. The per-space routes therefore resolve their space here
 * instead, through the same helper the middleware uses (spec §4.3).
 */
function requireSpaceFromParam(param: "id" | "spaceId") {
  // Marked: every guard mounted behind this one reads the caller's set in the
  // space the PATH names, not in the space the request entered — a reader of
  // the route table cannot see that from the mounts alone.
  return markSpaceRescope(async (c: Context<AppEnv>, next: Next) => {
    const spaceId = c.req.param(param)!;
    const space = await validateSpaceInOrg(spaceId, c.get("orgId"));
    if (!space) throw notFound(`Space '${spaceId}' not found in this organization`);
    await applySpacePermissions(c, space);
    return next();
  });
}

// ─── Space packages: the permission is per PACKAGE TYPE ────────────────
//
// `spaces:write` is ORG-level — the catalog verb that creates and deletes
// spaces — so gating activate/configure/deactivate on it would stop a space
// admin activating an agent in the space they run while letting anyone who can
// create a space activate one everywhere. The fit is the space-level string for
// the TYPE being activated, which the per-type package routes already use.
//
// `agents:configure` rather than `agents:write`: activating does not author the
// agent, it decides which space runs it.
//
// The permission STRINGS keep the spelling their role rows carry
// (`integrations:install` / `integrations:uninstall`): those are data in
// `space_roles` and in every API key's scope list, and renaming a grant is a
// migration of rows, not of code.
type SpacePackageOp = "activate" | "configure" | "deactivate";

/**
 * Step 1 of {@link gateSpacePackageWrite}, callable on its own.
 *
 * It needs no package id — that is the whole point — so a route whose id
 * travels in the BODY runs it BEFORE parsing that body, and a caller with no
 * authority over this space gets the 403 rather than a 400 about a payload they
 * were never entitled to submit. Returns the personal-space exemption so the
 * second half does not recompute it.
 */
async function coarseSpacePackageGate(
  c: Context<AppEnv>,
  orgId: string,
  op: SpacePackageOp,
): Promise<boolean> {
  const owner = c.get("space")?.ownerUserId ?? null;
  const ownSpace =
    op !== "configure" && owner !== null && owner === callerPersonalOwnerId(c, orgId);
  if (!ownSpace) {
    const alternatives = (["agent", "skill", "integration", "mcp-server"] as const).map((type) =>
      spacePackagePermission(type, op),
    );
    await requireAnyPermission(alternatives)(c, async () => {});
  }
  return ownSpace;
}

/**
 * Gate a space-package write and resolve the package's type, in the order that
 * keeps 403 and 404 independent of each other.
 *
 *   1. **Coarse gate, before any catalog read**
 *      ({@link coarseSpacePackageGate}). A caller holding none of the four
 *      strings this op can require is refused without the row being looked up,
 *      so the route is not an enumeration oracle.
 *   2. **Catalog lookup**, through `assertCatalogPackageAccess` — the same
 *      reachability rule the READ routes obey, for all three ops, so `POST`,
 *      `DELETE` and `PATCH` cannot be told apart by their refusals. Two different
 *      `detail` strings here (org-visible but unreachable vs nonexistent) would
 *      be an existence oracle over the whole catalogue.
 *   3. **Exact gate** for the resolved type.
 *
 * A residue at step 3 is accepted: a caller holding `skills:write` but not
 * `agents:configure` still tells an existing agent (403) from a missing one
 * (404). Inherent to gating per type, and far narrower than letting any space
 * member enumerate the catalog.
 *
 * ONE exception, and it is the whole authorization story of a PERSONAL space
 * (RBAC spec §3.6): in the caller's OWN personal space the `activate` /
 * `deactivate` grants are not required — ownership is the authorization. A
 * `guest` holds only `operator` there, which carries none of them, so requiring
 * them would mean a recipient could never take up a package offered to them.
 * Both gates are skipped together; the CATALOG read is not, so an unreachable
 * package stays a 404 in their own space too, and the offer is re-checked under
 * a row lock inside `activatePackage`. `configure` keeps its grant even there:
 * choosing a model spends the organization's LLM budget.
 */
async function gateSpacePackageWrite(
  c: Context<AppEnv>,
  orgId: string,
  packageId: string,
  op: SpacePackageOp,
  opts?: {
    /**
     * What {@link coarseSpacePackageGate} already answered, for a route that
     * had to run step 1 early. Absent, step 1 runs here.
     */
    ownSpace?: boolean;
  },
): Promise<PackageType> {
  const ownSpace = opts?.ownSpace ?? (await coarseSpacePackageGate(c, orgId, op));

  const { type } = await assertCatalogPackageAccess(c, packageId);

  // Reusing `requirePermission` rather than an inline `has` keeps the denial
  // audit hook, the 403 body and the fail-closed semantics identical to every
  // other RBAC call site — the move `requirePackageReadPermission` makes in
  // `routes/packages.ts`. An unmapped type fails CLOSED.
  if (!ownSpace) await makePermissionGuard(spacePackagePermission(type, op))(c, async () => {});
  return type;
}

/** Counts go snake_case on the wire; `spaceId` is the universal-id carve-out. */
function toSweepWire(
  spaceId: string,
  counts: { rehomedPackages: number; deletedPackages: number },
): SpaceSweepResult {
  return {
    object: "space_sweep",
    spaceId,
    rehomed_packages: counts.rehomedPackages,
    deleted_packages: counts.deletedPackages,
  };
}

export function createSpacesRouter() {
  const router = new Hono<AppEnv>();

  // `/:spaceId/*` also matches the bare `/:spaceId`. An exact twin would run the
  // guard twice and, as an `ALL` exact mount, serve every method at `/:id`.
  router.use("/:spaceId/*", pinnedSpaceScopeGuard);

  router.get(
    "/:spaceId/library",
    requireSpaceFromParam("spaceId"),
    requirePermission("spaces", "read"),
    async (c) => {
      return c.json(await getPackageLibrary(c, c.req.param("spaceId")));
    },
  );

  // GET /api/spaces — list spaces the caller reaches (RBAC spec §6.3)
  router.get("/", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    // Lazy repair (plan decision 4). Every membership door provisions the
    // personal space in its own transaction; this is the net for a member
    // provisioned before the feature existed — `scripts/migration/0015` does
    // them in bulk, and this makes the script optional for anyone who logs in.
    // Only for a principal that HAS one — any `user` principal, whatever the
    // transport (`callerPersonalOwnerId`). A delegate or an end-user must not
    // create one for the credential's creator behind their back.
    // `ensurePersonalSpace` reads before it writes, so the common case costs
    // one indexed lookup and no row lock.
    const personalOwnerId = callerPersonalOwnerId(c);
    if (personalOwnerId) await ensurePersonalSpaceFor(orgId, personalOwnerId);
    const entries = await listSpacesForPrincipal(
      orgId,
      callerOrgRole(c),
      c.get("user").id,
      personalOwnerId,
      personaMemberships(personaFor(c, orgId)),
    );
    // A credential PINNED to a space never enumerates its siblings: it sees the
    // one space it is bound to, whatever its subject reaches. Keyed on the
    // pinned space rather than on `authMethod === "api_key"`, for the reason
    // `pinnedSpaceScopeGuard` is (issue #1313) — any strategy that pins a space
    // is confined, not just the one auth method that did when this was written.
    const pinnedSpaceId = c.get("spaceId");
    const scoped = pinnedSpaceId ? entries.filter((e) => e.space.id === pinnedSpaceId) : entries;
    return c.json(
      listResponse(scoped.map(({ space, role }) => spaceWireForCaller(c, space, role))),
    );
  });

  // POST /api/spaces — create a new space
  router.post("/", requirePermission("spaces", "write"), async (c) => {
    if (!isUserPrincipal(c)) {
      throw forbidden("Only the user's own credential can create spaces");
    }
    const orgId = c.get("orgId");
    const user = c.get("user");
    const data = await readJsonBody(c, createSpaceSchema);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const space = await createSpace(orgId, data, user.id);
      await recordAuditFromContext(c, {
        action: "space.created",
        resourceType: "space",
        resourceId: space.id,
        after: { name: space.name },
      });
      // The creator holds org-level `spaces:write`, i.e. owner or admin, so
      // the resolver answers preset `admin` without any row — and no row is
      // written, per RBAC spec §6.3.
      const role = resolveSpaceRole(callerOrgRole(c), space, null, callerPersonalOwnerId(c));
      return c.json(spaceWireForCaller(c, space, role), 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space creation failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // GET /api/spaces/:id — get space detail. Visible exactly when it would
  // appear in this caller's listing (`isSpaceVisibleTo`, the same predicate);
  // hidden means 404, not 403 — the space does not exist for them.
  router.get("/:id", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;

    try {
      const space = await getSpace(orgId, spaceId);
      const orgRole = callerOrgRole(c);
      // Judged on the snapshot (RBAC spec §4.4); its access columns overlay the
      // full row in the response, so the body shows the state that was judged.
      const access = await callerSpaceAccess(c, space);
      if (!access) throw notFound(`Space '${spaceId}' not found in this organization`);
      const role = resolveSpaceRole(orgRole, access.space, access.member, callerPersonalOwnerId(c));
      if (!isSpaceVisibleTo(orgRole, access.space, role)) {
        throw notFound(`Space '${spaceId}' not found in this organization`);
      }
      return c.json(spaceWireForCaller(c, { ...space, ...access.space }, role));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Failed to get space", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PATCH /api/spaces/:id — update space. `space-settings:write` (preset admin),
  // resolved from the PATH space, not from `X-Space-Id`.
  router.patch(
    "/:id",
    requireSpaceFromParam("id"),
    requirePermission("space-settings", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const spaceId = c.req.param("id")!;
      const data = await readJsonBody(c, updateSpaceSchema);
      const current = c.get("space")!;
      // A stored default can become effective later. Opening also grants the
      // existing default to every implicit member, even when it is not edited.
      if (
        (data.default_role !== undefined && data.default_role !== current.defaultRole) ||
        (data.visibility === "open" && current.visibility !== "open")
      ) {
        assertCanGrantSpaceRole(c.get("permissions"), {
          kind: "preset",
          preset: data.default_role ?? current.defaultRole,
        });
      }

      if (data.settings?.allowedRedirectDomains) {
        const validationError = validateDomainList(data.settings.allowedRedirectDomains);
        if (validationError) throw invalidRequest(validationError);
      }

      try {
        const { default_role, ...rest } = data;
        const space = await updateSpace(
          orgId,
          spaceId,
          { ...rest, defaultRole: default_role },
          current,
        );
        await recordAuditFromContext(c, {
          action: "space.updated",
          resourceType: "space",
          resourceId: space.id,
          after: {
            name: data.name,
            settings: data.settings,
            visibility: data.visibility,
            defaultRole: default_role,
          },
        });
        return c.json(spaceWireForCaller(c, space, c.get("spaceRole") ?? null));
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.error("Space update failed", {
          spaceId,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // DELETE /api/spaces/:id — delete space
  router.delete("/:id", requirePermission("spaces", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;

    try {
      // 404 vs 409 for a personal space, decided where all three
      // administrative acts decide it — a 409 on somebody else's LIVE personal
      // space would confirm that the id is one (RBAC spec §3.6).
      assertSpaceAdminAct(await getSpace(orgId, spaceId), callerFor(c), "delete");
      await deleteSpace(orgId, spaceId);
      await recordAuditFromContext(c, {
        action: "space.deleted",
        resourceType: "space",
        resourceId: spaceId,
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space deletion failed", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // ─── Personal spaces: the two administrative acts (RBAC spec §3.6) ──
  //
  // Owners and admins do not read or write a personal space. Both acts apply to
  // an ORPHANED one only — the 30-day window after its owner left — and what
  // separates 404 from 409 on either is `assertSpaceAdminAct`, the one place
  // that decision is made for all three routes.
  //
  // Both are audited and both refuse a DELEGATE: a key holds `spaces:write`
  // and `spaces:delete` legitimately (it provisions spaces headlessly), but
  // creating, converting or sweeping a space is a person's decision, not an
  // automation step — the same line `POST /api/spaces` draws. So the act
  // answers to the person's own credential; the privacy refusal is a separate
  // question, and `callerPersonalOwnerId` is the one that makes it.

  // POST /api/spaces/:id/convert-to-team — the transfer.
  router.post("/:id/convert-to-team", requirePermission("spaces", "write"), async (c) => {
    if (!isUserPrincipal(c)) {
      throw forbidden("Only the user's own credential can convert a personal space");
    }
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;
    assertSpaceAdminAct(await getSpace(orgId, spaceId), callerFor(c), "convert-to-team");
    const space = await convertPersonalSpaceToTeam(orgId, spaceId);
    await recordAuditFromContext(c, {
      action: "space.converted_to_team",
      resourceType: "space",
      resourceId: space.id,
    });
    // The caller now holds `admin` here through their org role, so the
    // projection is the ordinary one.
    const role = resolveSpaceRole(callerOrgRole(c), space, null, callerPersonalOwnerId(c));
    return c.json(spaceWireForCaller(c, space, role));
  });

  // POST /api/spaces/:id/sweep-now — run the offboarding routine immediately,
  // instead of waiting for the rest of the 30-day window.
  router.post("/:id/sweep-now", requirePermission("spaces", "delete"), async (c) => {
    if (!isUserPrincipal(c)) {
      throw forbidden("Only the user's own credential can delete a personal space");
    }
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;
    assertSpaceAdminAct(await getSpace(orgId, spaceId), callerFor(c), "sweep");
    const counts = await emptyAndDeletePersonalSpace(orgId, spaceId);
    await recordAuditFromContext(c, {
      action: "space.swept",
      resourceType: "space",
      resourceId: spaceId,
      after: counts,
    });
    return c.json(toSweepWire(spaceId, counts));
  });

  // ─── Space members (RBAC spec §6.4) ────────────────────────────────

  // Every member route resolves the PATH space first, so `space-members:*`
  // (preset `admin`) is read from the caller's set in THAT space. Hono runs a
  // `/x/*` middleware on bare `/x` too, so one mount covers the collection.
  router.use("/:id/members/*", requireSpaceFromParam("id"));

  router.get(
    "/:id/roles",
    requireSpaceFromParam("id"),
    requireAnyPermission([
      "space-members:invite",
      "space-members:change-role",
      "space-settings:write",
    ]),
    async (c) => {
      const permissions = c.get("permissions");
      // This listing answers "what can I assign HERE", so it is filtered by the
      // same thing the assignment refuses on: the caller's own permissions in
      // this space. A role granting more than the caller holds is not offered,
      // preset and bundle alike — the org catalogue (`GET /api/roles`) is the
      // unfiltered one.
      const roles = await listSpaceRoles(c.get("orgId"));
      return c.json(
        listResponse(
          roles.filter((role) =>
            role.kind === "preset"
              ? canGrantSpaceRole(permissions, {
                  kind: "preset",
                  preset: role.key as SpaceRolePreset,
                })
              : canGrantSpaceRole(permissions, {
                  kind: "custom",
                  role: { ...role, id: role.id! },
                }),
          ),
        ),
      );
    },
  );

  // GET /api/spaces/:id/members — who actually has access, not who was added.
  // `space-members:read` opens the list; the IMPLICIT half of it is the org
  // directory seen through a space, so it needs `members:read` on top (RBAC
  // spec §6.4). A guest holding preset `admin` here manages the roles this
  // space granted and enumerates nothing else.
  router.get("/:id/members", requirePermission("space-members", "read"), async (c) => {
    const includeImplicit = c.get("permissions")?.has("members:read") ?? false;
    return c.json(
      listResponse(await listSpaceMembers(c.get("orgId"), c.get("space")!.id, includeImplicit)),
    );
  });

  // POST /api/spaces/:id/members — grant an explicit role
  router.post("/:id/members", requirePermission("space-members", "invite"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;
    const data = await readJsonBody(c, addSpaceMemberSchema);
    const assignment = toAssignment(data);
    const userId = data.userId ?? (await resolveOrgMemberEmail(orgId, data.email!));

    await saveSpaceMember({
      orgId,
      spaceId,
      userId,
      assignment,
      actorPermissions: c.get("permissions"),
      addedBy: c.get("user").id,
    });
    await recordAuditFromContext(c, {
      action: "space.member_added",
      resourceType: "space_member",
      resourceId: `${spaceId}:${userId}`,
      after: auditSpaceRole(assignment),
    });
    return c.json({ object: "space_member", userId, ...assignment }, 201);
  });

  // PATCH /api/spaces/:id/members/:userId — change an existing explicit role
  router.patch(
    "/:id/members/:userId",
    requirePermission("space-members", "change-role"),
    async (c) => {
      const orgId = c.get("orgId");
      const spaceId = c.req.param("id")!;
      const userId = c.req.param("userId")!;
      const data = await readJsonBody(c, updateSpaceMemberSchema);
      const assignment = toAssignment(data);

      await saveSpaceMember({
        orgId,
        spaceId,
        userId,
        assignment,
        actorPermissions: c.get("permissions"),
        addedBy: c.get("user").id,
        requireExisting: true,
      });
      await recordAuditFromContext(c, {
        action: "space.member_role_changed",
        resourceType: "space_member",
        resourceId: `${spaceId}:${userId}`,
        after: auditSpaceRole(assignment),
      });
      return c.json({ object: "space_member", userId, ...assignment });
    },
  );

  // DELETE /api/spaces/:id/members/:userId — drop the explicit role.
  // `access_after` says whether that ends their access or drops them back to
  // the open space's implicit membership; the caller should not have to
  // re-derive it from the visibility.
  router.delete("/:id/members/:userId", requirePermission("space-members", "remove"), async (c) => {
    const space = c.get("space")!;
    const userId = c.req.param("userId")!;

    // Both bounds — the standing left behind must be one the caller could have
    // granted, and the standing being dropped one they could have granted too —
    // are asserted inside `removeSpaceMember`, on the rows it acts on and under
    // the lock the grant path holds. Judged here they would rest on an org role
    // a concurrent promotion can move between the read and the DELETE (#1439),
    // which is also why `access_after` comes back from that transaction rather
    // than from a lookup after it.
    const { removed, accessAfter } = await removeSpaceMember({
      orgId: c.get("orgId"),
      space,
      userId,
      actorPermissions: c.get("permissions"),
    });
    if (!removed) throw notFound("Space member not found");
    await recordAuditFromContext(c, {
      action: "space.member_removed",
      resourceType: "space_member",
      resourceId: `${space.id}:${userId}`,
    });

    return c.json({ access_after: accessAfter ? "implicit" : "none" });
  });

  // ─── Space packages (activate / deactivate / configure) ────────────

  // Guard: resolve the PATH space and the caller's role in it, once for all
  // /:spaceId/packages/* routes. These are space-scoped by their path, not by
  // `X-Space-Id`, so they resolve their own space — `run-config` gates on
  // `agents:read`, a space-level string that org context alone never carries.
  router.use("/:spaceId/packages/*", requireSpaceFromParam("spaceId"));

  // GET /api/spaces/:spaceId/packages — list this space's placements.
  // The `router.use` guard above only proves the space belongs to the org;
  // `spaces:read` is the read twin of the `spaces:write` the mutating routes
  // carry, and matches this route being package-type agnostic.
  router.get("/:spaceId/packages", requirePermission("spaces", "read"), async (c) => {
    const spaceId = c.req.param("spaceId")!;
    const orgId = c.get("orgId");
    const type = c.req.query("type") as PackageType | undefined;
    const rows = await listSpacePackages({ orgId, spaceId: spaceId }, type);
    const readable = rows.filter((row) =>
      c.get("permissions")?.has(packagePermission(row.package_type, "read")),
    );
    return c.json(listResponse(readable.map((row) => ({ object: "space_package", ...row }))));
  });

  // POST /api/spaces/:spaceId/packages — ACTIVATE a package here. THE door, for
  // a team space and a personal one alike, and for all four package types:
  // there is no per-type activation route beside it.
  //
  // Idempotent by construction: the placement row is upserted, so a second
  // activation answers with the same body instead of a 409 and brings back
  // every setting the space had chosen. 201 when this call put the package on,
  // 200 when it already was — which covers a system integration, on with no row.
  //
  // When the package is neither HOMED nor SHARED here, this route can CREATE
  // the share — but only for a caller holding `<type>:share` in its home
  // (`assertPackageShareAccess`: 404 unreachable, 403 reachable but not theirs
  // to hand out). Activating is therefore not a way around `share`. An API key
  // never carries it, so a key activates the already-placed and nothing else.
  //
  // No permission guard is mounted: the gate below reads the package's own rows
  // (`gateSpacePackageWrite`, `assertPackageShareAccess`).
  router.post("/:spaceId/packages", async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("spaceId")!;
    const scope = { orgId, spaceId };

    // Coarse gate FIRST, before the body is even parsed: it asks nothing about
    // the package, so a caller holding none of the four activation grants is
    // refused with the 403 the gate exists to give rather than a 400 about the
    // shape of a payload they were never entitled to send.
    const ownSpace = await coarseSpacePackageGate(c, orgId, "activate");
    const data = await readJsonBody(c, activatePackageSchema);
    await gateSpacePackageWrite(c, orgId, data.packageId, "activate", { ownSpace });

    // Read first, to decide whether the caller must ALSO prove `<type>:share`.
    // The authoritative check is `activatePackage`'s, under the share row's
    // lock, in the transaction that writes: a revoke racing this read makes the
    // activation refuse rather than commit a placement nothing backs.
    const placed = await isPackageReadableInSpace(spaceId, data.packageId);
    let activation;
    if (placed) {
      activation = await activatePackage(scope, data.packageId);
    } else {
      await assertPackageShareAccess(c, data.packageId);
      activation = await activatePackage(scope, data.packageId, { shareBy: c.get("user").id });
    }
    // Whether this call is what put the package ON — the activation rule read
    // before the write. A package the deployment already switches on with no
    // row at all (a system package, an integration named by
    // `SYSTEM_INTEGRATIONS`) was active before the click and stays active
    // after it: the row it gains records a decision that changes nothing.
    const turnedOn = !activation.wasActive;
    // The AUDIENCE changed — recorded off what the transaction actually wrote,
    // not off the read above: a concurrent activation may have put the offer in
    // first, and an entry naming an act that did not happen is worse than no
    // entry.
    //
    // `targetKind: "space"` because that is what was named: this route takes a
    // space id, never a person (a personal space's id stays off the wire, and
    // it is not on this one either — it is the space the caller is already
    // acting in).
    if (activation.shared) {
      await recordAuditFromContext(c, {
        action: "package.shared",
        resourceType: "package",
        resourceId: data.packageId,
        after: { spaceId, targetKind: "space" },
      });
    }
    // Only a call that actually turned the package ON is an activation worth
    // recording: a repeat says nothing new, and the audit trail of a toggle is
    // unreadable when every poll writes to it.
    if (turnedOn) {
      await recordAuditFromContext(c, {
        action: "package.activated",
        resourceType: "package",
        resourceId: data.packageId,
        after: { spaceId },
      });
    }
    // 201 says this call turned the package on; 200 says it was already on.
    // The body is the row the TRANSACTION wrote, not a re-read: a second SELECT
    // would describe whatever state the table is in when it lands, which under
    // concurrency is somebody else's act.
    return c.json({ object: "space_package", ...activation.placement }, turnedOn ? 201 : 200);
  });

  // GET /api/spaces/:spaceId/packages/:packageId — one placement, in detail
  router.get(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("spaces", "read"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const row = await getSpacePackage({ orgId, spaceId: spaceId }, packageId);
      // A row the caller may not read reads as absent, exactly as the list
      // route omits it. Answering 403 instead would turn this route into a
      // package-type oracle for a role that cannot see the row at all.
      if (!row || !c.get("permissions")?.has(packagePermission(row.package_type, "read"))) {
        throw new ApiError({
          status: 404,
          code: "package_not_placed",
          title: "Package Not Placed",
          detail: `Package '${packageId}' is not placed in this space`,
        });
      }
      return c.json({ object: "space_package", ...row });
    },
  );

  // PATCH /api/spaces/:spaceId/packages/:packageId — merge-update config
  router.patch(`/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const spaceId = c.req.param("spaceId")!;
    const orgId = c.get("orgId");
    const scope = { orgId, spaceId: spaceId };
    const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;

    // Gate FIRST — before the body is parsed, and before any read of the
    // placement row. The id is in the PATH here, so the whole gate can run
    // ahead of the payload: a caller with no authority gets the 403 without
    // learning whether the package is placed here, and without a validation
    // error standing in for it. `requirePlacement` below turns a missing row
    // into the 404, and only a caller who passed the gate can see it.
    //
    // ONE gate, always `configure`: this route chooses how an already-placed
    // package runs, and nothing else. Activation left it when it got its own
    // pair of doors, so an empty body is gated exactly like a full one and can
    // never be a free existence probe.
    const type = await gateSpacePackageWrite(c, orgId, packageId, "configure");
    const data = await readJsonBody(c, updatePackageSchema);
    if (data.chat_enforced !== undefined && type !== "skill") {
      throw new ApiError({
        status: 400,
        code: "chat_enforced_not_skill",
        title: "Not A Skill",
        detail: `Only a skill can be enforced in the chat; '${packageId}' is a ${type}`,
        param: "chat_enforced",
      });
    }

    const placement = await getSpacePackage(scope, packageId);
    let generationConfig = data.generation_config;
    if (placement && (data.modelId !== undefined || generationConfig !== undefined)) {
      const effectiveModelId = data.modelId !== undefined ? data.modelId : placement.modelId;
      const explicitModel =
        data.modelId !== undefined ? await assertExplicitModelExists(orgId, data.modelId) : null;
      const selectedModel =
        explicitModel ?? (await resolveModel(orgId, packageId, effectiveModelId));

      if (generationConfig && Object.keys(generationConfig).length > 0) {
        generationConfig = validateGenerationOverride(
          generationConfig,
          selectedModel,
          "generation_config",
        );
      } else if (
        generationConfig === undefined &&
        data.modelId !== undefined &&
        placement.generation_config
      ) {
        // Reconcile only when `modelId` is part of THIS patch: re-clamping
        // stored settings is a response to the selected model possibly
        // having changed, and a patch that never mentions `modelId` cannot
        // change it. Without the conjunct a patch naming only the proxy would
        // silently rewrite `generation_config` on a request that never named
        // it.
        generationConfig = reconcileModelGenerationSettings(
          placement.generation_config,
          selectedModel?.generation,
        );
      }
    }

    const { generation_config: _generationConfig, chat_enforced: chatEnforced, ...rest } = data;
    void _generationConfig;
    const updates = {
      ...rest,
      ...(generationConfig !== undefined ? { generationConfig } : {}),
      ...(chatEnforced !== undefined ? { chatEnforced } : {}),
    };
    // An EXISTING placement only: a package not placed here (or not visible
    // to the org) is a 404, never an implicit activation via upsert.
    const { chatEnforcedChanged } = await updatePlacementSettings(scope, packageId, updates);
    if (chatEnforcedChanged) {
      await recordAuditFromContext(c, {
        action: chatEnforced ? "package.chat_enforced" : "package.chat_released",
        resourceType: "package",
        resourceId: packageId,
        after: { spaceId },
      });
    }
    const updated = await getSpacePackage(scope, packageId);
    return c.json({ object: "space_package", ...updated });
  });

  // DELETE /api/spaces/:spaceId/packages/:packageId — DEACTIVATE it here.
  //
  // The placement row and every setting on it stay, so switching a package off
  // for a week costs nothing to undo. Two acts remove the row, and neither is
  // this one: revoking the share that placed it (`DELETE …/shares/{target}`),
  // and a home move that releases the space it left
  // (`PUT …/home` with `keep_in_previous_home: false`).
  //
  // 204 when the space has a row, and when it has none but the package is ON by
  // the DEPLOYMENT's default — there the row is MATERIALIZED saying `false`,
  // the sticky opt-out. That default is the activation rule's, not a reading of
  // `source`: a `system`-provenance integration this deployment does NOT offer
  // is off already and falls into the case below. 404 for anything else with no
  // row — an offer nobody has taken up is not on, and writing the row would
  // turn it into "switched off", a decision its recipient never made.
  router.delete(`/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const spaceId = c.req.param("spaceId")!;
    const orgId = c.get("orgId");
    const scope = { orgId, spaceId: spaceId };
    const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
    await gateSpacePackageWrite(c, orgId, packageId, "deactivate");
    const { changed } = await deactivatePackage(scope, packageId);
    // Symmetric with `package.activated`: only a call that actually switched
    // the package off is worth recording. A repeat says nothing new, and the
    // same argument that keeps the other door quiet applies here — a log full
    // of no-op deactivations is a log nobody can read a real one out of.
    if (changed) {
      await recordAuditFromContext(c, {
        action: "package.deactivated",
        resourceType: "package",
        resourceId: packageId,
        after: { spaceId },
      });
    }
    return c.body(null, 204);
  });

  // GET /api/spaces/:spaceId/packages/:scope/:name/run-config —
  // single source of truth for the per-space config and the model/proxy
  // override. Consumed by the CLI to reproduce a UI run without hand-stitching
  // three separate calls. It carries no version: the space selects no
  // definition, so a run without an explicit selector is the latest published
  // one wherever it is launched from.
  router.get(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}/run-config`,
    requirePermission("agents", "read"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const resolved = await getResolvedRunConfig({ orgId, spaceId }, packageId);
      if (!resolved) {
        throw new ApiError({
          status: 404,
          code: "package_not_placed",
          title: "Package Not Placed",
          detail: `Package '${packageId}' is not placed in this space`,
        });
      }
      return c.json(resolved);
    },
  );

  return router;
}
