// SPDX-License-Identifier: Apache-2.0

/**
 * The `oauth_resources` rows behind the MCP endpoints, and the in-process
 * verifier set that mirrors them (`lib/audiences.ts`).
 *
 * The AS mints a token for a `resource` only when that identifier has a row.
 * An org's row is written when the org is created and reconciled from the
 * `organizations` table; a space's row is written on demand, the first time the
 * AS is asked for that space's resource (`ensureMcpResourceMintable`, called
 * from the `/oauth2/authorize` and `/oauth2/token` gate), and swept once the
 * space is gone.
 */

import { and, eq, like, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { organizations, oauthResource, spaces } from "@appstrate/db/schema";
import {
  getMcpOrgResourceUri,
  getMcpSpaceResourceUri,
  parseMcpResourceUri,
  setMcpOrgVerifyAudiences,
} from "../../lib/audiences.ts";

// GUID-shaped, like the router's `:org` check: an org id that is not one can
// name no row, and must not reach a uuid column comparison.
const orgIdSchema = z.guid();

/**
 * `value` as a LIKE prefix pattern. `_` and `%` are LIKE wildcards, so an
 * APP_URL carrying either would over-match — escape them (Postgres' default
 * LIKE escape is the backslash).
 */
function likePrefix(value: string): string {
  return `${value.replace(/([\\%_])/g, "\\$1")}%`;
}

/** The `oauth_resources` row backing one org's MCP endpoint. */
export function mcpOrgResourceRow(orgId: string) {
  return {
    id: crypto.randomUUID(),
    identifier: getMcpOrgResourceUri(orgId),
    name: `MCP endpoint for organization ${orgId}`,
  };
}

/** The `oauth_resources` row backing one space's MCP endpoint. */
function mcpSpaceResourceRow(orgId: string, spaceId: string) {
  return {
    id: crypto.randomUUID(),
    identifier: getMcpSpaceResourceUri(orgId, spaceId),
    name: `MCP endpoint for space ${spaceId} of organization ${orgId}`,
  };
}

/**
 * Reconcile the MCP audience model with the live tables: the durable,
 * cross-replica MINT rows and this process's VERIFIER set. Org rows are written
 * for every org; a row under the MCP prefix is deleted unless it is exactly an
 * org's or a live space's identifier. Idempotent, and symmetric, so a lost
 * `onOrgCreate` and a lost `onOrgDelete` both converge here.
 *
 * The delete names no roster: its `NOT EXISTS` clauses are evaluated by
 * Postgres against the live `organizations` and `spaces` tables, so "is this
 * row's org or space gone?" is answered at the instant of the delete rather
 * than by a list read earlier. An org or space that commits while this runs is
 * therefore never swept — its row is written only after it is committed. The
 * roster read below feeds the verifier set and the insert, which are additive:
 * seeing a stale roster costs one tick of convergence, never a deletion.
 */
export async function reconcileMcpAudiences(): Promise<void> {
  const rows = await db.select({ id: organizations.id }).from(organizations);
  setMcpOrgVerifyAudiences(rows.map((r) => r.id));
  // Only MCP URIs are ours to drop: the two static platform identifiers the AS
  // seeds sit outside this prefix.
  const prefix = getMcpOrgResourceUri("");
  await db.delete(oauthResource).where(
    and(
      like(oauthResource.identifier, likePrefix(prefix)),
      notExists(
        db
          .select({ live: sql`1` })
          .from(organizations)
          .where(eq(oauthResource.identifier, sql`${prefix} || ${organizations.id}`)),
      ),
      notExists(
        db
          .select({ live: sql`1` })
          .from(spaces)
          .where(
            eq(
              oauthResource.identifier,
              sql`${prefix} || ${spaces.orgId} || '/s/' || ${spaces.id}`,
            ),
          ),
      ),
    ),
  );
  if (rows.length === 0) return;
  await db
    .insert(oauthResource)
    .values(rows.map((r) => mcpOrgResourceRow(r.id)))
    .onConflictDoNothing({ target: oauthResource.identifier });
}

/**
 * AS gate hook: make a space's MCP resource mintable by writing its row, when
 * the URI names a space that exists in that org. Org URIs (rows written with
 * the org) and anything else are a no-op, so the AS answers `invalid_target`
 * for a space of another org or a space that does not exist. Idempotent.
 */
export async function ensureMcpResourceMintable(uri: string): Promise<void> {
  const binding = parseMcpResourceUri(uri);
  if (binding?.spaceId === undefined) return;
  if (!orgIdSchema.safeParse(binding.orgId).success) return;
  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.id, binding.spaceId), eq(spaces.orgId, binding.orgId)))
    .limit(1);
  if (!space) return;
  await db
    .insert(oauthResource)
    .values(mcpSpaceResourceRow(binding.orgId, binding.spaceId))
    .onConflictDoNothing({ target: oauthResource.identifier });
}

/** Delete an org's MCP row and every row of its spaces (on org deletion). */
export async function dropMcpOrgResources(orgId: string): Promise<void> {
  const orgUri = getMcpOrgResourceUri(orgId);
  await db
    .delete(oauthResource)
    .where(
      or(
        eq(oauthResource.identifier, orgUri),
        like(oauthResource.identifier, likePrefix(`${orgUri}/s/`)),
      ),
    );
}
