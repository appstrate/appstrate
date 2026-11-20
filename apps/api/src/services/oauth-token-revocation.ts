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
  oauthGrantState,
  oauthRefreshToken,
  spaces,
} from "@appstrate/db/schema";
import { and, arrayContains, arrayOverlaps, eq, sql, type SQL } from "drizzle-orm";
import {
  getMcpOrgResourceUri,
  getMcpSpaceResourceUri,
  parseMcpResourceUri,
} from "../lib/audiences.ts";
import { inTransaction, type DbOrTx, type Tx } from "../lib/db-helpers.ts";

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

/** An MCP grant's key: (user, OAuth client, MCP resource URI). */
interface McpGrantKey {
  userId: string;
  clientId: string;
  resource: string;
}

async function raiseWatermarks(tx: Tx, grants: McpGrantKey[]): Promise<void> {
  for (const { userId, clientId, resource } of grants) {
    const binding = parseMcpResourceUri(resource);
    // Skipping would withdraw a resource with no watermark left to refuse its tokens.
    if (!binding) throw new Error(`Not an MCP resource URI: ${resource}`);
    const now = new Date();
    await tx
      .insert(oauthGrantState)
      .values({
        userId,
        clientId,
        resource,
        orgId: binding.orgId,
        spaceId: binding.spaceId ?? null,
        tokensValidAfter: now,
      })
      .onConflictDoUpdate({
        target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
        set: { tokensValidAfter: now },
      });
  }
}

/**
 * Refuse every MCP access token `userId` holds, from its next request: raise
 * the watermark of each of the user's grants, leaving tokens, consents and the
 * grants themselves to the caller. Tokens issued after it are accepted.
 */
export async function raiseMcpWatermarksOfUser(executor: DbOrTx, userId: string): Promise<void> {
  await inTransaction(executor, async (tx) => {
    // Same lock order as `endMcpGrants`, so two writers cannot deadlock. Ids and URIs
    // are ASCII, where `COLLATE "C"` and its code-unit sort agree.
    await tx
      .select({ userId: oauthGrantState.userId })
      .from(oauthGrantState)
      .where(eq(oauthGrantState.userId, userId))
      .orderBy(
        sql`${oauthGrantState.clientId} COLLATE "C"`,
        sql`${oauthGrantState.resource} COLLATE "C"`,
      )
      .for("update");
    await tx
      .update(oauthGrantState)
      .set({ tokensValidAfter: new Date() })
      .where(eq(oauthGrantState.userId, userId));
  });
}

/**
 * End MCP grants: withdraw each one's resource from its tokens and from the
 * user's consent to the client (reconnecting shows the consent screen again),
 * and raise its watermark so an access token already issued is refused on its
 * next request.
 *
 * Each grant's row is locked first and its watermark set last, after the
 * deletes: a token request that read a code or refresh token before them began
 * before the watermark, and `admitMcpTokenIssuance` (OIDC module) refuses its
 * response.
 */
export async function endMcpGrants(tx: Tx, unordered: McpGrantKey[]): Promise<void> {
  // Fixed (client, resource) order: the lock order `raiseMcpWatermarksOfUser` uses too.
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const grants = [...unordered].sort(
    (a, b) => byCodeUnit(a.clientId, b.clientId) || byCodeUnit(a.resource, b.resource),
  );
  // Creates and locks each grant's row.
  await raiseWatermarks(tx, grants);
  for (const { userId, clientId, resource } of grants) {
    for (const table of [oauthRefreshToken, oauthAccessToken, oauthConsent]) {
      await withdrawResource(
        tx,
        table,
        and(eq(table.userId, userId), eq(table.clientId, clientId)),
        resource,
      );
    }
  }
  // Refuses a token request that read a token before the deletes.
  await raiseWatermarks(tx, grants);
}

/**
 * End every MCP grant `userId` holds on `orgId`'s endpoints (the org's and
 * each space's), whatever the client: the grants found on its tokens, its
 * consents and its recorded issuances. Grants on another org's endpoints are
 * untouched, even when one authorization covers both.
 */
export async function endMcpGrantsInOrg(tx: Tx, orgId: string, userId: string): Promise<void> {
  const orgSpaces = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  const orgResources = new Set([
    getMcpOrgResourceUri(orgId),
    ...orgSpaces.map((s) => getMcpSpaceResourceUri(orgId, s.id)),
  ]);
  const grants = new Map<string, McpGrantKey>();
  const add = (clientId: string, resource: string) =>
    grants.set(`${clientId}\u0000${resource}`, { userId, clientId, resource });

  for (const table of [oauthRefreshToken, oauthAccessToken, oauthConsent]) {
    const rows = await tx
      .select({ clientId: table.clientId, resources: table.resources })
      .from(table)
      .where(and(eq(table.userId, userId), arrayOverlaps(table.resources, [...orgResources])));
    for (const row of rows) {
      for (const resource of row.resources ?? []) {
        if (orgResources.has(resource)) add(row.clientId, resource);
      }
    }
  }
  const states = await tx
    .select({ clientId: oauthGrantState.clientId, resource: oauthGrantState.resource })
    .from(oauthGrantState)
    .where(and(eq(oauthGrantState.userId, userId), eq(oauthGrantState.orgId, orgId)));
  for (const state of states) add(state.clientId, state.resource);

  await endMcpGrants(tx, [...grants.values()]);
}
