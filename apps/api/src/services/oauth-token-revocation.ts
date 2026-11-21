// SPDX-License-Identifier: Apache-2.0

/**
 * Ending OAuth tokens on the platform's side: their rows are deleted, never
 * marked `revoked`. Better Auth reads a revoked refresh token presented again
 * as a stolen one and deletes every refresh token of the (client, user) pair,
 * on every resource: ending one grant would end that client's grants on every
 * other endpoint and org. A deleted token presented again is a plain
 * `invalid_grant`. Rows Better Auth itself marked at rotation go too, for the
 * same reason. Access-token rows of a deleted refresh token go with it
 * (`refresh_id` cascade).
 */

import {
  oauthAccessToken,
  oauthConsent,
  oauthClient,
  oauthGrantState,
  oauthRefreshToken,
  spaces,
} from "@appstrate/db/schema";
import { and, arrayContains, arrayOverlaps, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../lib/audiences.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";

type TokenTable = typeof oauthRefreshToken | typeof oauthAccessToken;
type ResourceBoundTable = TokenTable | typeof oauthConsent;

/** Delete the refresh and access tokens `where` selects in each table. */
export async function deleteOAuthTokens(
  executor: DbOrTx,
  where: (table: TokenTable) => SQL | undefined,
): Promise<void> {
  await executor.delete(oauthRefreshToken).where(where(oauthRefreshToken));
  await executor.delete(oauthAccessToken).where(where(oauthAccessToken));
}

/**
 * Take `resource` off the rows `where` selects. One authorization may cover
 * several MCP endpoints (the client asked for several at `/oauth2/authorize`,
 * and each token request then picks one): a row left with no resource is
 * deleted, one covering others keeps them.
 */
export async function withdrawResource(
  executor: DbOrTx,
  table: ResourceBoundTable,
  where: SQL | undefined,
  resource: string,
): Promise<void> {
  const covering = and(where, arrayContains(table.resources, [resource]));
  const remaining = sql`array_remove(${table.resources}, ${resource})`;
  await executor.delete(table).where(and(covering, sql`cardinality(${remaining}) = 0`));
  await executor
    .update(table as typeof oauthRefreshToken)
    .set({ resources: remaining })
    .where(covering);
}

/** Issuance and administrative revocations take this lock before touching grant or token rows. */
export async function lockOAuthGrantsOfUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`oauth-grants:${userId}`})::bigint)`,
  );
}

interface McpGrantKey {
  clientId: string;
  resource: string;
  orgId: string;
  spaceId: string | null;
}

/** Caller holds the user's grant lock. Set the watermark after the resource withdrawals. */
async function withdrawMcpGrants(tx: Tx, userId: string, grants: McpGrantKey[]): Promise<void> {
  if (!grants.length) return;
  for (const { clientId, resource } of grants) {
    for (const table of [oauthRefreshToken, oauthAccessToken, oauthConsent]) {
      await withdrawResource(
        tx,
        table,
        and(eq(table.userId, userId), eq(table.clientId, clientId)),
        resource,
      );
    }
  }
  const now = new Date();
  await tx
    .insert(oauthGrantState)
    .values(
      grants.map(({ clientId, resource, orgId, spaceId }) => ({
        userId,
        clientId,
        resource,
        orgId,
        spaceId,
        tokensValidAfter: now,
      })),
    )
    .onConflictDoUpdate({
      target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
      set: { tokensValidAfter: now },
    });
}

export async function endMcpGrants(tx: Tx, userId: string, grants: McpGrantKey[]): Promise<void> {
  await lockOAuthGrantsOfUser(tx, userId);
  await withdrawMcpGrants(tx, userId, grants);
}

/**
 * End every MCP grant `userId` holds on `orgId`'s endpoints (the org's and
 * each space's), whatever the client: the grants found on its tokens, its
 * consents and its recorded issuances. Grants on another org's endpoints are
 * untouched, even when one authorization covers both.
 */
export async function endOAuthAccessInOrg(tx: Tx, orgId: string, userId: string): Promise<void> {
  await lockOAuthGrantsOfUser(tx, userId);
  const orgSpaces = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  const orgResources = new Map<string, string | null>([[getMcpOrgResourceUri(orgId), null]]);
  for (const space of orgSpaces)
    orgResources.set(getMcpSpaceResourceUri(orgId, space.id), space.id);
  const grants = new Map<string, McpGrantKey>();
  const add = (clientId: string, resource: string, spaceId: string | null) =>
    grants.set(`${clientId}\u0000${resource}`, { orgId, spaceId, clientId, resource });

  for (const table of [oauthRefreshToken, oauthAccessToken, oauthConsent]) {
    const rows = await tx
      .select({ clientId: table.clientId, resources: table.resources })
      .from(table)
      .where(
        and(eq(table.userId, userId), arrayOverlaps(table.resources, [...orgResources.keys()])),
      );
    for (const row of rows) {
      for (const resource of row.resources ?? []) {
        const spaceId = orgResources.get(resource);
        if (spaceId !== undefined) add(row.clientId, resource, spaceId);
      }
    }
  }
  const states = await tx
    .select({
      clientId: oauthGrantState.clientId,
      resource: oauthGrantState.resource,
      spaceId: oauthGrantState.spaceId,
    })
    .from(oauthGrantState)
    .where(and(eq(oauthGrantState.userId, userId), eq(oauthGrantState.orgId, orgId)));
  for (const state of states) add(state.clientId, state.resource, state.spaceId);

  // Org-owned clients can re-provision membership on refresh through allowSignup.
  const orgClientIds = tx
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(and(eq(oauthClient.level, "org"), eq(oauthClient.referencedOrgId, orgId)));
  await deleteOAuthTokens(tx, (table) =>
    and(eq(table.userId, userId), inArray(table.clientId, orgClientIds)),
  );
  await withdrawMcpGrants(tx, userId, [...grants.values()]);
}
