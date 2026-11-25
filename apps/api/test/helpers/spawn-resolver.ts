// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveIntegrationSpawns` for tests that do not exercise version pinning: each integration the
 * agent declares is frozen on its draft unless the test supplies its own `integrationVersions`.
 * (The real resolver requires the run's frozen map, as every launch path provides one.)
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaces } from "@appstrate/db/schema";
import { resolveIntegrationSpawns as resolveSpawns } from "../../src/services/integration-spawn-resolver.ts";
import type { ResolvedIntegrationVersionMap } from "../../src/services/integration-service.ts";

type SpawnInput = Parameters<typeof resolveSpawns>[0];

export function resolveIntegrationSpawns(
  input: Omit<SpawnInput, "integrationVersions" | "orgId"> & {
    integrationVersions?: ResolvedIntegrationVersionMap;
    orgId?: string;
  },
): ReturnType<typeof resolveSpawns> {
  return withOrg(input);
}

async function withOrg(
  input: Omit<SpawnInput, "integrationVersions" | "orgId"> & {
    integrationVersions?: ResolvedIntegrationVersionMap;
    orgId?: string;
  },
): ReturnType<typeof resolveSpawns> {
  const orgId =
    input.orgId ??
    (await db.select({ orgId: spaces.orgId }).from(spaces).where(eq(spaces.id, input.spaceId)))[0]!
      .orgId;
  const declared = Object.keys(
    ((input.agentManifest.dependencies as { integrations?: Record<string, unknown> } | undefined)
      ?.integrations ?? {}) as Record<string, unknown>,
  );
  const draftFrozen: ResolvedIntegrationVersionMap = Object.fromEntries(
    declared.map((id) => [id, { source: "draft" as const, version: null }]),
  );
  return resolveSpawns({
    ...input,
    orgId,
    integrationVersions: input.integrationVersions ?? draftFrozen,
  });
}
