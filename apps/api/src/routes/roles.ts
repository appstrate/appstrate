// SPDX-License-Identifier: Apache-2.0

/**
 * Custom space roles — `/api/roles` (RBAC spec §6.2).
 *
 * ORG-scoped: a bundle belongs to the organization and is assignable in any of
 * its spaces, so `roles:*` is an org-level permission and this router stays
 * outside `SPACE_SCOPED_PREFIXES`. Reading is always available; DEFINING a
 * bundle is what `features.custom_roles` turns on (§9).
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";
import { getAppConfig } from "../lib/app-config.ts";
import { assertSpaceRoleId } from "../lib/ids.ts";
import { listResponse } from "../lib/list-response.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { spaceLevelVocabulary } from "../lib/permissions.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import {
  createSpaceRole,
  deleteSpaceRole,
  listSpaceRoles,
  updateSpaceRole,
} from "../services/space-roles.ts";

/** Slug shape: lowercase, letter-initial, ≤64 characters. */
const roleKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/,
    "key must be lowercase, start with a letter, and contain only letters, digits and dashes (max 64)",
  );

export const createSpaceRoleSchema = z
  .object({
    key: roleKeySchema,
    name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(z.string().min(1)),
  })
  .strict();

export const updateSpaceRoleSchema = z
  .object({
    key: roleKeySchema.optional(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Gate the write routes on `features.custom_roles`. Read per request, not at
 * router construction: modules merge their features into `AppConfig` at boot,
 * and a captured boolean would freeze whatever the flag was before that.
 */
function requireCustomRolesFeature() {
  return async (_c: Context<AppEnv>, next: Next) => {
    if (!getAppConfig().features.custom_roles) {
      throw new ApiError({
        status: 403,
        code: "feature_unavailable",
        title: "Feature Unavailable",
        detail:
          "Defining custom space roles requires the `custom_roles` feature, provided by the " +
          "Appstrate Cloud plan (the `@appstrate/cloud` module). The four built-in presets " +
          "(admin, builder, operator, viewer) are always available.",
      });
    }
    return next();
  };
}

/** The `srl_` id a path param carries, shape-checked before any query. */
function roleIdParam(c: Context<AppEnv>): string {
  const id = c.req.param("id")!;
  assertSpaceRoleId(id);
  return id;
}

export function createRolesRouter() {
  const router = new Hono<AppEnv>();
  const featureGate = requireCustomRolesFeature();

  // MUST register before `/:id`, which would otherwise match "vocabulary".
  router.get("/vocabulary", requirePermission("roles", "read"), (c) => {
    return c.json(listResponse(spaceLevelVocabulary()));
  });

  router.get("/", requirePermission("roles", "read"), async (c) => {
    return c.json(listResponse(await listSpaceRoles(c.get("orgId"))));
  });

  router.post("/", requirePermission("roles", "write"), featureGate, async (c) => {
    const data = await readJsonBody(c, createSpaceRoleSchema);
    const role = await createSpaceRole({
      orgId: c.get("orgId"),
      createdBy: c.get("user").id,
      input: data,
    });
    await recordAuditFromContext(c, {
      action: "role.created",
      resourceType: "space_role",
      resourceId: role.id!,
      after: { key: role.key, name: role.name, permissions: role.permissions },
    });
    return c.json(role, 201);
  });

  router.patch("/:id", requirePermission("roles", "write"), featureGate, async (c) => {
    const id = roleIdParam(c);
    const data = await readJsonBody(c, updateSpaceRoleSchema);
    const role = await updateSpaceRole({ orgId: c.get("orgId"), id, patch: data });
    await recordAuditFromContext(c, {
      action: "role.updated",
      resourceType: "space_role",
      resourceId: id,
      after: { key: role.key, name: role.name, permissions: role.permissions },
    });
    return c.json(role);
  });

  // Refused with a count while anyone still holds the role — see the service.
  router.delete("/:id", requirePermission("roles", "delete"), featureGate, async (c) => {
    const id = roleIdParam(c);
    const role = await deleteSpaceRole(c.get("orgId"), id);
    await recordAuditFromContext(c, {
      action: "role.deleted",
      resourceType: "space_role",
      resourceId: id,
      before: { key: role.key, name: role.name, permissions: role.permissions },
    });
    return c.body(null, 204);
  });

  return router;
}
