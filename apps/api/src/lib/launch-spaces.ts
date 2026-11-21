// SPDX-License-Identifier: Apache-2.0

/** Where a launch refused here for a configuration reason could run instead (`active_in_spaces`); computed on refusals only. */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { credentialReachableSpaces } from "./reachable-spaces.ts";
import type { Permission } from "./permissions.ts";
import { isInlineShadowPackageId } from "../services/inline-run.ts";
import { requiredIntegrationIds } from "../services/integration-connection-resolver.ts";
import {
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
} from "../services/integration-service.ts";
import {
  resolveAgentRunManifest,
  VERSION_SELECTOR_DRAFT,
} from "../services/agent-version-resolver.ts";
import {
  assertDependencyDraftOverridesAllowed,
  assertDraftSelectorAllowed,
} from "./package-access.ts";
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
interface LaunchDoor {
  /** Refuses on an inactive required integration: default `true`, `false` for the bundle export. */
  integrations?: boolean;
  version?: string;
  dependencyOverrides?: Record<string, string> | null;
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
  { integrations = true, version, dependencyOverrides }: LaunchDoor = {},
): LaunchSpacesLookup {
  return async ({ packageId, manifest, manifestCache }) => {
    if (c.get("principalKind") === "end_user") return [];
    // Draft authority on a space-bound credential is checked in the entered space.
    // A draft admitted here cannot follow that credential into another space.
    if (
      c.get("credentialSpaceIds") !== undefined &&
      [version, ...Object.values(dependencyOverrides ?? {})].some(
        (selector) => selector?.trim() === VERSION_SELECTOR_DRAFT,
      )
    )
      return [];
    const orgId = c.get("orgId");
    const candidates = await otherSpacesHolding(c, required);
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
    return candidates.filter((space) => active.has(space.id));
  };
}

/**
 * Other spaces within the credential's reach where the caller holds every `required`
 * permission. No agent is involved, so nothing is judged for activation: the lookup above
 * cannot serve an inline run, which has no placed package to look for.
 */
export async function otherSpacesHolding(
  c: Context<AppEnv>,
  required: readonly Permission[],
): Promise<LaunchSpace[]> {
  if (c.get("principalKind") === "end_user") return [];
  const here = c.get("spaceId");
  return (await credentialReachableSpaces(c, c.get("orgId")))
    .filter((space) => space.id !== here && required.every((p) => space.permissions.has(p)))
    .map(({ id, name }) => ({ id, name }));
}

/** The activation alternatives of a run or schedule for the exact version it requested. */
export async function activeSpacesForAgentVersion(
  c: Context<AppEnv>,
  required: readonly Permission[],
  version: string | undefined,
  dependencyOverrides: Record<string, string> | undefined,
): Promise<LaunchSpace[]> {
  const pkg = c.get("package");
  await assertDraftSelectorAllowed(c, pkg.id, version);
  const { agent } = await resolveAgentRunManifest(pkg, version);
  await assertDependencyDraftOverridesAllowed(c, dependencyOverrides, agent.manifest);
  const manifestCache: IntegrationManifestCache = new Map();
  const versions = await resolveRunIntegrationVersions({
    agentManifest: agent.manifest,
    orgId: c.get("orgId"),
    dependencyOverrides,
    manifestCache,
  });
  if (!versions.ok) return [];
  const lookup = launchSpacesLookup(c, required, { version, dependencyOverrides });
  return lookup({ packageId: pkg.id, manifest: agent.manifest, manifestCache });
}
