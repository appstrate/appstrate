// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a space row by id. Free of Hono and of the pipeline: the role preview
 * (`lib/view-as.ts`) needs these lookups before any middleware has run, and
 * keeping them in `middleware/space-context.ts` made `lib` and `middleware`
 * import each other.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { assertSpaceId } from "./ids.ts";

/** Space row exposed as `c.get("space")`. Keep the field set tight so services can destructure it. */
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
 * The space row, or null if it is not in `orgId`. Where a CLIENT-SUPPLIED
 * space id enters (middleware, SSE auth, MCP router), hence the id-shape guard,
 * run BEFORE the SELECT: a retired `app_` id is un-migrated data, not a missing
 * row, and must throw rather than 404 (header, key and row would still agree).
 * Paths reading the id from a row assert the shape themselves:
 * `requireSpaceContext` / `resolveMcpSpaceRow` fallbacks, `validateSSEAuth`.
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

/** The org's default space — the fallback for header-less in-process MCP re-entry (see `requireSpaceContext`). */
export async function defaultSpaceForOrg(orgId: string): Promise<SpaceContextRow | null> {
  const [space] = await db
    .select(SPACE_CONTEXT_COLUMNS)
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.isDefault, true)))
    .limit(1);
  return space ?? null;
}
