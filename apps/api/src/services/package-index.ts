// SPDX-License-Identifier: Apache-2.0

/**
 * The package INDEXES: what each space can LAUNCH, one row per (package, space)
 * where the package is ACTIVE, each row carrying its `spaceId`. The single-space
 * index (`GET /api/agents`, `GET /api/packages/{type}`) is the one-space case;
 * the organization's (`GET /api/orgs/{orgId}/agents|packages/{type}`) lists
 * every space it admits. Each costs the same number of queries whatever the
 * number of spaces.
 *
 * The ONE activation rule decides (`services/package-activation.ts`): the
 * placement row when the package is placed in the space, the deployment's
 * default when it is not — the rule the integration resolver, the run gate and
 * the caller-context hints state. What is merely PLACED in a space — a package
 * switched off — belongs to its library (`GET /api/spaces/{spaceId}/library`).
 *
 * Order: system packages first, then the index's own order (the agent index
 * by id, a catalog index newest first, then by id), then the space id — so one space's
 * index keeps its order, and a package active in several spaces has its rows
 * side by side.
 */

import { inArray } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { profiles } from "@appstrate/db/schema";
import { asRecord } from "@appstrate/core/safe-json";
import { parseScopedName } from "@appstrate/core/naming";
import { readAgentAppearance, type PackageType } from "@appstrate/core/validation";
import type { AgentManifest } from "../types/index.ts";
import { readsAgentContent, type SpaceGrant } from "../lib/permissions.ts";
import {
  homeWireForCaller,
  visibleHomeSpaceId,
  type PackageAccessSpace,
} from "../lib/package-access.ts";
import { isPublished, listActivePackages } from "./space-packages.ts";
import { getRunningRunCounts } from "./state/runs.ts";
import { getUnreadRunCountsByAgent } from "./state/run-reads.ts";
import { listOrgItems } from "./package-items/crud.ts";
import { CONFIG_BY_TYPE } from "./package-items/config.ts";

/**
 * The agent index of the spaces of `grants`, as `actor` reads each with its
 * grant there: whether a row is a summary and which runs its counters span
 * follow the row's space, never the request's.
 */
export async function listAgentIndex(
  orgId: string,
  grants: readonly SpaceGrant[],
  actor: Actor,
  accessible: PackageAccessSpace[],
) {
  const permissions = new Map(grants.map((g) => [g.spaceId, g.permissions]));
  const [rows, runningCounts, unreadCounts] = await Promise.all([
    listActivePackages(orgId, [...permissions.keys()], "agent"),
    getRunningRunCounts(orgId, grants, actor),
    getUnreadRunCountsByAgent(orgId, grants, actor),
  ]);

  return rows.map((row) => {
    const summaryOnly = !readsAgentContent(permissions.get(row.spaceId)!);
    const manifest = asRecord(row.draftManifest) as AgentManifest;
    const parsed = parseScopedName(manifest.name);
    const appearance = readAgentAppearance(manifest as Record<string, unknown>);
    return {
      id: row.id,
      spaceId: row.spaceId,
      home_space_id: visibleHomeSpaceId(row, accessible),
      ...appearance,
      display_name: manifest.display_name,
      description: manifest.description,
      schema_version: manifest.schema_version,
      author: manifest.author,
      keywords: manifest.keywords ?? [],
      // `skills` says what the agent is BUILT FROM — the
      // one thing in this list a summary read withholds. `integrations` says
      // which SaaS it talks to, which is what a launcher connects, so it
      // answers every caller. Everything else is how the launcher names and
      // picks an agent, which `agents:run` is entitled to.
      dependencies: {
        ...(summaryOnly
          ? {}
          : {
              skills: (manifest.dependencies?.skills ?? {}) as Record<string, string>,
            }),
        integrations: (manifest.dependencies?.integrations ?? {}) as Record<string, string>,
      },
      running_runs: runningCounts.get(row.spaceId)?.get(row.id) ?? 0,
      // The caller's own unread runs of this agent (per recipient, like a
      // schedule's `unread_count`).
      unread_count: unreadCounts.get(row.spaceId)?.get(row.id) ?? 0,
      source: row.source ?? "local",
      // Canonical scope format includes the `@` sigil (e.g. "@myorg") so
      // list output is directly usable as `{scope}` path-param input — one
      // operation's output must be valid input for the next.
      scope: parsed ? `@${parsed.scope}` : null,
      // `version` from the manifest may be absent on a partial draft; the DB
      // `type` column is NOT NULL and authoritative (manifest JSONB can lie).
      version: manifest.version ?? null,
      // The draft manifest's `version` above says nothing about publication:
      // `published` is whether omitting the version selector at launch resolves.
      published: isPublished(row),
      type: row.type,
    };
  });
}

/**
 * The catalog index of one package `type` in `spaceIds` (`GET /api/packages/{type}`
 * and its organization twin; the agents' launcher index is
 * {@link listAgentIndex}). Nothing on a row depends on the caller's role in the
 * listed space: `home_space_id` / `home_*`
 * follow their role in the package's home, computed from `accessible`, the
 * caller's reach (`packageAccessSpaces`, RBAC spec §6.9).
 */
export async function listPackageIndex(
  type: PackageType,
  orgId: string,
  spaceIds: readonly string[],
  accessible: PackageAccessSpace[],
) {
  const items = await listOrgItems(orgId, CONFIG_BY_TYPE[type], spaceIds);
  const enriched = await enrichWithCreatorNames(items);
  return enriched.map(({ homeSpaceId, ...item }) => ({
    ...item,
    ...homeWireForCaller({ type, source: item.source, homeSpaceId }, accessible),
  }));
}

/** Enrich items with creator display names (batch lookup). */
async function enrichWithCreatorNames<T extends { created_by?: string | null }>(
  items: T[],
): Promise<(T & { created_by_name?: string })[]> {
  const userIds = [...new Set(items.map((i) => i.created_by).filter(Boolean))] as string[];
  if (userIds.length === 0) return items;

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, userIds));

  const nameMap = new Map(rows.map((p) => [p.id, p.displayName]));

  return items.map((item) => ({
    ...item,
    created_by_name: item.created_by ? (nameMap.get(item.created_by) ?? undefined) : undefined,
  }));
}
