// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator registry — the closed table of execution backends, keyed
 * by `RUN_ADAPTER` value. `RUN_ADAPTER` is a closed Zod enum, so the
 * table is a `Record<ExecutionMode, …>`: adding a backend without
 * declaring its security capabilities is a compile error, and there is no
 * runtime "unknown id" path to maintain (the env layer already rejects
 * unknown values).
 */

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";
import { FirecrackerOrchestrator } from "./firecracker/firecracker-orchestrator.ts";

export interface OrchestratorRegistration {
  /**
   * Whether this backend places each run inside a real isolation boundary
   * (container, microVM) that keeps run credentials out of the host API
   * process. Security-sensitive: the subscription-run policy refuses
   * OAuth-subscription agent runs on any backend that does not declare
   * this — a new backend is untrusted until it opts in explicitly.
   */
  readonly isolatesWorkloads: boolean;
  /**
   * Whether this backend can run a sidecar-only workload (no agent) —
   * the shape connect-runs use. The firecracker backend cannot: its VM
   * boots exactly once, driven by the agent workload, so a sidecar-only
   * launch would silently never start. Connect fails fast instead.
   */
  readonly supportsSidecarOnly: boolean;
  /** Build a fresh orchestrator instance. Called once per process (singleton held by index.ts). */
  readonly create: () => RunOrchestrator;
}

const ORCHESTRATORS: Record<ExecutionMode, OrchestratorRegistration> = {
  docker: {
    isolatesWorkloads: true,
    supportsSidecarOnly: true,
    create: () => new DockerOrchestrator(),
  },
  process: {
    // Workloads run as host subprocesses of the API user — no boundary.
    isolatesWorkloads: false,
    supportsSidecarOnly: true,
    create: () => new ProcessOrchestrator(),
  },
  firecracker: {
    isolatesWorkloads: true,
    supportsSidecarOnly: false,
    create: () => new FirecrackerOrchestrator(),
  },
};

/**
 * Runtime lookup that stays fail-closed even for an out-of-enum id (the
 * ExecutionMode type is a compile-time promise, but the value ultimately
 * comes from the environment — the security accessors below must degrade
 * to "no capability", not throw a TypeError).
 */
function registrationFor(id: ExecutionMode): OrchestratorRegistration | undefined {
  return (ORCHESTRATORS as Partial<Record<string, OrchestratorRegistration>>)[id];
}

export function selectOrchestrator(id: ExecutionMode): RunOrchestrator {
  const registration = registrationFor(id);
  if (!registration) {
    const known = Object.keys(ORCHESTRATORS).sort().join(", ");
    throw new Error(`Unknown RUN_ADAPTER "${id}" — registered orchestrators: ${known}`);
  }
  return registration.create();
}

/**
 * Whether the backend registered under `id` provides per-run isolation.
 * Fail-closed: an unknown id answers `false` — the subscription-run
 * policy then refuses the run rather than trusting an unregistered mode.
 */
export function orchestratorIsolatesWorkloads(id: ExecutionMode): boolean {
  return registrationFor(id)?.isolatesWorkloads ?? false;
}

/**
 * Whether the backend registered under `id` can run sidecar-only
 * workloads (connect-runs). Fail-closed on unknown ids.
 */
export function orchestratorSupportsSidecarOnly(id: ExecutionMode): boolean {
  return registrationFor(id)?.supportsSidecarOnly ?? false;
}

/** Ids of the backends that provide per-run isolation (sorted). */
export function isolatingOrchestratorIds(): ExecutionMode[] {
  return (Object.keys(ORCHESTRATORS) as ExecutionMode[])
    .filter((id) => ORCHESTRATORS[id].isolatesWorkloads)
    .sort();
}
