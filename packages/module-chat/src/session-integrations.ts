// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations a conversation reached, off `connection_calls`: its own calls and those of the
 * runs it launched. A row names at most one of the two, so no call is counted twice.
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls, packages, runs } from "@appstrate/db/schema";

/** One integration the conversation reached, as the context panel names and draws it. */
export interface SessionIntegration {
  id: string;
  /** The manifest's `display_name`, the id when it declares none or the package is gone. */
  display_name: string;
  /** The manifest's `icon`, `null` when it declares none or the package is gone. */
  icon: string | null;
}

/**
 * Each integration once, in order of its first call. One statement: a UNION ALL of the two
 * indexed paths, each grouped by integration, joined to the package for its name and icon.
 */
export async function listSessionIntegrations(
  sessionId: string,
  orgId: string,
): Promise<SessionIntegration[]> {
  const firstCall = {
    integrationId: connectionCalls.integrationId,
    firstAt: sql<Date>`min(${connectionCalls.createdAt})`.as("first_at"),
    firstId: sql<number>`min(${connectionCalls.id})`.as("first_id"),
  };
  const direct = db
    .select(firstCall)
    .from(connectionCalls)
    .where(and(eq(connectionCalls.orgId, orgId), eq(connectionCalls.chatSessionId, sessionId)))
    .groupBy(connectionCalls.integrationId);
  const viaRuns = db
    .select(firstCall)
    .from(connectionCalls)
    .where(
      and(
        eq(connectionCalls.orgId, orgId),
        inArray(
          connectionCalls.runId,
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.orgId, orgId), eq(runs.chatSessionId, sessionId))),
        ),
      ),
    )
    .groupBy(connectionCalls.integrationId);
  const calls = direct.unionAll(viaRuns).as("calls");
  // Each integration once, with its first call across both arms.
  const reached = db
    .select({
      integrationId: calls.integrationId,
      firstAt: sql<Date>`min(${calls.firstAt})`.as("reached_first_at"),
      firstId: sql<number>`min(${calls.firstId})`.as("reached_first_id"),
    })
    .from(calls)
    .groupBy(calls.integrationId)
    .as("reached");

  const manifest = packages.draftManifest;
  const displayName = sql<string>`(case
    when jsonb_typeof(${manifest} -> 'display_name') = 'string' then ${manifest} ->> 'display_name'
    else ${reached.integrationId}
  end)`;
  const icon = sql<string | null>`(case
    when jsonb_typeof(${manifest} -> 'icon') = 'string' then ${manifest} ->> 'icon'
  end)`;
  // The org's own package or a system one: never another organization's manifest.
  const visiblePackage = and(
    eq(packages.id, reached.integrationId),
    or(eq(packages.orgId, orgId), isNull(packages.orgId)),
  );
  return db
    .select({ id: reached.integrationId, display_name: displayName, icon })
    .from(reached)
    .leftJoin(packages, visiblePackage)
    .orderBy(asc(reached.firstAt), asc(reached.firstId), asc(reached.integrationId));
}
