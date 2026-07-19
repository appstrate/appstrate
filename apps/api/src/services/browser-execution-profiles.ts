// SPDX-License-Identifier: Apache-2.0

import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type {
  ExecutionCapabilityRequirement,
  ExecutionRequirements,
  WorkloadResources,
} from "@appstrate/core/platform-types";

export interface BrowserResourceProfile extends WorkloadResources {
  readonly id: "standard";
  readonly shmBytes: number;
  readonly maxContexts: number;
  readonly maxPages: number;
}

export const MAX_BROWSER_INSTANCES_PER_RUN = 4;

const MIB = 1024 * 1024;

const PROFILES: Readonly<Record<BrowserResourceProfile["id"], BrowserResourceProfile>> = {
  standard: {
    id: "standard",
    memoryBytes: 1024 * MIB,
    nanoCpus: 1_000_000_000,
    pidsLimit: 256,
    shmBytes: 256 * MIB,
    maxContexts: 1,
    maxPages: 4,
  },
};

export function getBrowserResourceProfile(id: string): BrowserResourceProfile {
  const profile = PROFILES[id as BrowserResourceProfile["id"]];
  if (!profile) {
    throw new Error(`unsupported browser execution profile '${id}'`);
  }
  return profile;
}

function addResources(a: WorkloadResources, b: WorkloadResources): WorkloadResources {
  return {
    memoryBytes: a.memoryBytes + b.memoryBytes,
    nanoCpus: a.nanoCpus + b.nanoCpus,
    pidsLimit: (a.pidsLimit ?? 0) + (b.pidsLimit ?? 0),
  };
}

/**
 * Recompute the only valid supplemental envelope from platform-owned profile
 * ids. Remote orchestrator inputs are checked against this result rather than
 * trusting client-supplied memory/CPU/PID totals.
 */
export function browserSupplementalResources(
  capabilities: readonly ExecutionCapabilityRequirement[],
): WorkloadResources {
  let instances = 0;
  let resources: WorkloadResources = { memoryBytes: 0, nanoCpus: 0, pidsLimit: 0 };
  for (const capability of capabilities) {
    if (
      capability.kind !== "browser" ||
      capability.profile !== "standard" ||
      !Number.isInteger(capability.instances) ||
      capability.instances <= 0
    ) {
      throw new Error("unsupported browser capability requirement");
    }
    instances += capability.instances;
    if (instances > MAX_BROWSER_INSTANCES_PER_RUN) {
      throw new Error(
        `browser capability requests ${instances} instances; maximum is ${MAX_BROWSER_INSTANCES_PER_RUN}`,
      );
    }
    const profile = getBrowserResourceProfile(capability.profile);
    resources = addResources(resources, {
      memoryBytes: profile.memoryBytes * capability.instances,
      nanoCpus: profile.nanoCpus * capability.instances,
      pidsLimit: (profile.pidsLimit ?? 0) * capability.instances,
    });
  }
  return resources;
}

/**
 * Aggregate platform-owned browser requirements before isolation-boundary
 * creation. One browser companion is provisioned per browser-enabled
 * integration; duplicate package ids still count because each spawn spec owns
 * an independent trust and session boundary.
 */
export function resolveBrowserExecutionRequirements(
  integrations: readonly IntegrationSpawnSpec[],
): ExecutionRequirements {
  const browserSpecs = integrations.flatMap((spec) => (spec.browser ? [spec.browser] : []));
  if (browserSpecs.length > MAX_BROWSER_INSTANCES_PER_RUN) {
    throw new Error(
      `run requests ${browserSpecs.length} browser instances; maximum is ${MAX_BROWSER_INSTANCES_PER_RUN}`,
    );
  }

  const instancesByProfile = new Map<BrowserResourceProfile["id"], number>();

  for (const spec of browserSpecs) {
    const profile = getBrowserResourceProfile(spec.profile);
    instancesByProfile.set(profile.id, (instancesByProfile.get(profile.id) ?? 0) + 1);
  }

  const capabilities = [...instancesByProfile.entries()].map(([profile, instances]) => ({
    kind: "browser" as const,
    profile,
    instances,
  }));

  return {
    capabilities,
    supplementalResources: browserSupplementalResources(capabilities),
  };
}

export function hasExecutionRequirements(requirements: ExecutionRequirements): boolean {
  return requirements.capabilities.length > 0;
}
