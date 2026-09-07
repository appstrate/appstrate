// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a space row by id, and the shape every reader of one shares.
 *
 * Free of Hono and of the request pipeline, like `lib/space-role.ts` and for a
 * second reason on top of it: these two lookups are what turns a
 * CLIENT-SUPPLIED space id into a row, and the role preview
 * (`lib/view-as.ts`) needs that before any middleware has run. Left in
 * `middleware/space-context.ts` they made `lib` import `middleware` and
 * `middleware` import `lib` — a cycle around the one function both halves of
 * space resolution need.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { assertSpaceId } from "./ids.ts";

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
 *   - `resolveMcpSpaceRow`'s default-space fallback (`modules/mcp/router.ts`)
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
