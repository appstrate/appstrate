// SPDX-License-Identifier: Apache-2.0

/** Where a launch refused here for a configuration reason could run instead (`active_in_spaces`); computed on refusals only. */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { credentialReachableSpaces } from "./reachable-spaces.ts";
import type { Permission } from "./permissions.ts";
import { isInlineShadowPackageId } from "../services/inline-run.ts";
import { requiredIntegrationIds } from "../services/integration-connection-resolver.ts";
import type { IntegrationManifestCache } from "../services/integration-service.ts";
import { spacesActiveForAll } from "../services/space-packages.ts";

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

/** What the refusing door checks beyond its permissions. */
export interface LaunchDoor {
  /** Refuses on an inactive required integration: default `true`, `false` for the bundle export. */
  integrations?: boolean;
}

/**
 * The spaces where the agent (an inline shadow has no placement) and, when the
 * door checks them, every integration it requires are active.
 */
export type LaunchSpacesLookup = (launch: RefusedLaunch) => Promise<LaunchSpace[]>;

/**
 * Other spaces where the caller holds every `required` permission of the refusing door, within
 * the credential's reach ({@link credentialReachableSpaces}: pinned gets `[]`). An end-user
 * acts in its own space only (RBAC spec §7.2): `[]`.
 */
export function launchSpacesLookup(
  c: Context<AppEnv>,
  required: readonly Permission[],
  { integrations = true }: LaunchDoor = {},
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
      ...(integrations ? await requiredIntegrationIds(manifest, manifestCache) : []),
    ];
    const active = await spacesActiveForAll(
      orgId,
      packageIds,
      candidates.map((space) => space.id),
    );
    return candidates.filter((space) => active.has(space.id)).map(({ id, name }) => ({ id, name }));
  };
}
