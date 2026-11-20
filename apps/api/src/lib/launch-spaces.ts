// SPDX-License-Identifier: Apache-2.0

/** Where a launch refused here for a configuration reason could run instead (`active_in_spaces`); computed on refusals only. */

import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { activeHereSql } from "../services/package-activation.ts";
import { placementReadFilter, placementRowJoin } from "../services/package-placement.ts";
import { notEphemeralFilter, orgOrSystemFilter } from "./package-helpers.ts";
import { credentialReachableSpaces } from "./reachable-spaces.ts";
import type { Permission } from "./permissions.ts";
import { isInlineShadowPackageId } from "../services/inline-run.ts";
import { requiredIntegrationIds } from "../services/integration-connection-resolver.ts";
import type { IntegrationManifestCache } from "../services/integration-service.ts";

/** A space by id and name, as the refusal names it. */
export interface LaunchSpace {
  id: string;
  name: string;
}

/** The launch refused here: the agent and the manifest the gate judged. */
interface RefusedLaunch {
  packageId: string;
  manifest: Record<string, unknown>;
  manifestCache?: IntegrationManifestCache;
}

/** The spaces where the agent (an inline shadow has no placement) and every required integration are active. */
export type LaunchSpacesLookup = (launch: RefusedLaunch) => Promise<LaunchSpace[]>;

/**
 * Other spaces where the caller holds every `required` permission of the refusing door, within
 * the credential's reach ({@link credentialReachableSpaces}: pinned gets `[]`). An end-user
 * acts in its own space only (RBAC spec §7.2): `[]`.
 */
export function launchSpacesLookup(
  c: Context<AppEnv>,
  required: readonly Permission[],
): LaunchSpacesLookup {
  return async ({ packageId, manifest, manifestCache }) => {
    if (c.get("principalKind") === "end_user") return [];
    const orgId = c.get("orgId");
    const here = c.get("spaceId");
    const candidates = (await credentialReachableSpaces(c, orgId)).filter(
      (space) => space.id !== here && required.every((p) => space.permissions.has(p)),
    );
    if (candidates.length === 0) return [];
    const packageIds = [
      ...(isInlineShadowPackageId(packageId) ? [] : [packageId]),
      ...(await requiredIntegrationIds(manifest, manifestCache)),
    ];
    return spacesActiveForAll(orgId, packageIds, candidates);
  };
}

/** The `candidates` (in their order) where every one of `packageIds` is placed and active. */
async function spacesActiveForAll(
  orgId: string,
  packageIds: readonly string[],
  candidates: readonly LaunchSpace[],
): Promise<LaunchSpace[]> {
  const wanted = new Set(packageIds);
  if (wanted.size === 0 || candidates.length === 0) return [];
  const rows = await db
    .select({ spaceId: spaces.id })
    .from(packages)
    .innerJoin(
      spaces,
      and(
        eq(spaces.orgId, orgId),
        inArray(
          spaces.id,
          candidates.map((space) => space.id),
        ),
      ),
    )
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaces.id))
    .where(
      and(
        inArray(packages.id, [...wanted]),
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        placementReadFilter(spaces.id),
        activeHereSql(),
      ),
    );
  const activeCount = new Map<string, number>();
  for (const { spaceId } of rows) activeCount.set(spaceId, (activeCount.get(spaceId) ?? 0) + 1);
  return candidates
    .filter((space) => activeCount.get(space.id) === wanted.size)
    .map(({ id, name }) => ({ id, name }));
}
