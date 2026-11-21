// SPDX-License-Identifier: Apache-2.0

/**
 * The package indexes: one row per package ACTIVE in one of the listed spaces (the activation
 * rule of `services/package-activation.ts`), each carrying `space_ids` (its home first). The
 * single-space index is the one-space case. Order: system packages first, then the index's own.
 */

import { inArray } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { profiles } from "@appstrate/db/schema";
import { asRecord } from "@appstrate/core/safe-json";
import { parseScopedName } from "@appstrate/core/naming";
import { readAgentAppearance, type PackageType } from "@appstrate/core/validation";
import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import type { AgentManifest } from "../types/index.ts";
import { readsAgentContent, type SpaceGrant } from "../lib/permissions.ts";
import {
  homeWireForCaller,
  visibleHomeSpaceId,
  type PackageAccessSpace,
} from "../lib/package-access.ts";
import { isPublished, listActivePackages } from "./space-packages.ts";
import {
  inactiveAmong,
  requiredIds,
  usedIntegrations,
  type InactiveDeclaredIntegration,
  type IntegrationRequirement,
} from "./integration-connection-resolver.ts";
import { selectorlessLaunchManifests } from "./agent-version-resolver.ts";
import { getRunningRunCounts } from "./state/runs.ts";
import { getUnreadRunCountsByAgent } from "./state/run-reads.ts";
import { listOrgItems } from "./package-items/crud.ts";
import { CONFIG_BY_TYPE } from "./package-items/config.ts";

/**
 * The agent index of the spaces of `grants`, as `actor` reads each with its
 * grant there: a row's counters span the agent's runs in every space of
 * `grants`, each space counting the runs its grant admits, and the row is a
 * summary unless one of its spaces grants the content read. `reach` (the
 * caller's `packageAccessSpaces`) is awaited alongside the index's own reads.
 * `singleSpaceId`: the one space a single-space index lists, whose activations
 * name each row's `inactive_required_integrations`.
 */
export async function listAgentIndex(
  orgId: string,
  grants: readonly SpaceGrant[],
  actor: Actor,
  reach: Promise<PackageAccessSpace[]>,
  singleSpaceId?: string,
) {
  const permissions = new Map(grants.map((g) => [g.spaceId, g.permissions]));
  const [rows, runningCounts, unreadCounts, accessible] = await Promise.all([
    listActivePackages(orgId, [...permissions.keys()], "agent"),
    getRunningRunCounts(orgId, grants, actor),
    getUnreadRunCountsByAgent(orgId, grants, actor),
    reach,
  ]);
  // What a launch with `version` omitted runs, not the draft: the integrations a row names are
  // the ones its run uses.
  const used = await usedIntegrations(await selectorlessLaunchManifests(rows), orgId);
  // Single-space index only: an organization row spans spaces, each with its own activations.
  const inactive = singleSpaceId ? await inactiveAmong(used, singleSpaceId) : null;

  return rows.map((row, i) => {
    const summaryOnly = !row.spaceIds.some((spaceId) =>
      readsAgentContent(permissions.get(spaceId)!),
    );
    const manifest = asRecord(row.draftManifest) as AgentManifest;
    const parsed = parseScopedName(manifest.name);
    const appearance = readAgentAppearance(manifest as Record<string, unknown>);
    return {
      id: row.id,
      space_ids: row.spaceIds,
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
      integrations: listedIntegrations(used[i]!, inactive?.[i] ?? []),
      running_runs: runningCounts.get(row.id) ?? 0,
      // The caller's own unread runs of this agent (per recipient, like a
      // schedule's `unread_count`).
      unread_count: unreadCounts.get(row.id) ?? 0,
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
      ...(inactive ? { inactive_required_integrations: requiredIds(inactive[i]!) } : {}),
    };
  });
}

/** One collation whatever the host's locale, so a row's order is the same on every replica. */
const NAME_ORDER = new Intl.Collator("en");

/**
 * The integrations of an agent row, named and drawn off the manifests its launch pins. An optional
 * one `inactive` in the listed space is left out: a run there starts without it. A required one
 * stays, since it refuses the launch (`inactive_required_integrations`). The manifest's
 * declaration order does not survive JSONB, so the row gives its own: the required ones first,
 * then by name.
 */
function listedIntegrations(
  used: readonly IntegrationRequirement[],
  inactive: readonly InactiveDeclaredIntegration[],
) {
  const skipped = new Set(
    inactive.filter((entry) => !entry.required).map((entry) => entry.integrationId),
  );
  return used
    .filter((req) => !skipped.has(req.integrationId))
    .map((req) => ({
      id: req.integrationId,
      name: req.manifest.display_name ?? req.integrationId,
      icon: req.manifest.icon ?? null,
      required: req.required,
      authenticated: !isUnauthenticatedIntegration(req.manifest),
    }))
    .sort((a, b) => Number(b.required) - Number(a.required) || NAME_ORDER.compare(a.name, b.name));
}

/**
 * The catalog index of one package `type` in `spaceIds` (`GET /api/packages/{type}`
 * and its organization twin; the agents' launcher index is
 * {@link listAgentIndex}). Nothing on a row depends on the caller's role in the
 * listed space: `home_space_id` / `home_*`
 * follow their role in the package's home, computed from `reach`, the
 * caller's `packageAccessSpaces` (RBAC spec §6.9), awaited alongside the items.
 */
export async function listPackageIndex(
  type: PackageType,
  orgId: string,
  spaceIds: readonly string[],
  reach: Promise<PackageAccessSpace[]>,
) {
  const [items, accessible] = await Promise.all([
    listOrgItems(orgId, CONFIG_BY_TYPE[type], spaceIds),
    reach,
  ]);
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
