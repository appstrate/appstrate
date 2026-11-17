// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveIntegrationSpawns` for tests that do not exercise version pinning: each integration the
 * agent declares is frozen on its draft unless the test supplies its own `integrationVersions`.
 * (The real resolver requires the run's frozen map, as every launch path provides one.)
 */

import { resolveIntegrationSpawns as resolveSpawns } from "../../src/services/integration-spawn-resolver.ts";
import type { ResolvedIntegrationVersionMap } from "../../src/services/integration-service.ts";

type SpawnInput = Parameters<typeof resolveSpawns>[0];

export function resolveIntegrationSpawns(
  input: Omit<SpawnInput, "integrationVersions"> & {
    integrationVersions?: ResolvedIntegrationVersionMap;
  },
): ReturnType<typeof resolveSpawns> {
  const declared = Object.keys(
    ((input.agentManifest.dependencies as { integrations?: Record<string, unknown> } | undefined)
      ?.integrations ?? {}) as Record<string, unknown>,
  );
  const draftFrozen: ResolvedIntegrationVersionMap = Object.fromEntries(
    declared.map((id) => [id, { source: "draft" as const, version: null }]),
  );
  return resolveSpawns({ ...input, integrationVersions: input.integrationVersions ?? draftFrozen });
}
