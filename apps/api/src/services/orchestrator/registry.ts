// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator registry — the table of execution backends, keyed by
 * `RUN_ADAPTER` value. Core registers its own backends (docker, process)
 * below; modules contribute additional ones via
 * `AppstrateModule.orchestrators()`, registered by the module loader at
 * load time — before any orchestrator is instantiated.
 *
 * Security posture (replaces the previous compile-time-closed
 * `Record<ExecutionMode, …>` table): a duplicate id is a fatal boot error
 * (never silently shadowed), the capability accessors degrade fail-closed
 * ("no capability") for unregistered ids, and a module's capability
 * declaration carries operator trust — code listed in `MODULES` already
 * runs inside the API process.
 */

import type { RunOrchestrator, OrchestratorRegistration } from "@appstrate/core/platform-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";

export type { OrchestratorRegistration } from "@appstrate/core/platform-types";

interface OwnedRegistration extends OrchestratorRegistration {
  /** Module id that contributed this backend ("core" for built-in ones). */
  readonly owner: string;
}

const ORCHESTRATORS = new Map<string, OwnedRegistration>();

/**
 * Register an execution backend under a `RUN_ADAPTER` id. Called by core
 * (below) and by the module loader for each module's `orchestrators()`
 * contribution. A duplicate id is fatal — the second registration would
 * silently shadow the first at `RUN_ADAPTER` resolution time, and
 * credentials-affecting capabilities must never be ambiguous.
 */
export function registerOrchestrator(
  id: string,
  registration: OrchestratorRegistration,
  owner: string,
): void {
  const existing = ORCHESTRATORS.get(id);
  if (existing) {
    throw new Error(
      `"${existing.owner}" and "${owner}" both declared orchestrator ${JSON.stringify(id)}. ` +
        `Backend ids must be unique across core and loaded modules — the second ` +
        `contribution would silently shadow the first at RUN_ADAPTER resolution time.`,
    );
  }
  ORCHESTRATORS.set(id, { ...registration, owner });
}

function registerCoreOrchestrators(): void {
  registerOrchestrator(
    "docker",
    {
      isolatesWorkloads: true,
      supportsSidecarOnly: true,
      create: () => new DockerOrchestrator(),
    },
    "core",
  );
  registerOrchestrator(
    "process",
    {
      // Workloads run as host subprocesses of the API user — no boundary.
      isolatesWorkloads: false,
      supportsSidecarOnly: true,
      create: () => new ProcessOrchestrator(),
    },
    "core",
  );
}

registerCoreOrchestrators();

export function selectOrchestrator(id: ExecutionMode): RunOrchestrator {
  const registration = ORCHESTRATORS.get(id);
  if (!registration) {
    // The firecracker module's HTTP-client backend used to register as
    // `firecracker-remote` (alongside a now-removed in-process backend).
    // It is now simply `firecracker` — point stale configs at the new id.
    if (id === "firecracker-remote") {
      throw new Error(
        `Unknown RUN_ADAPTER "firecracker-remote" — it was renamed to "firecracker". ` +
          `Set RUN_ADAPTER=firecracker (the firecracker module now contributes a single ` +
          `backend that proxies to the appstrate-runner daemon).`,
      );
    }
    const known = [...ORCHESTRATORS.keys()].sort().join(", ");
    throw new Error(
      `Unknown RUN_ADAPTER ${JSON.stringify(id)} — registered orchestrators: ${known}. ` +
        `If a module provides this backend (e.g. "firecracker"), add it to MODULES.`,
    );
  }
  return registration.create();
}

/**
 * Whether the backend registered under `id` provides per-run isolation.
 * Fail-closed: an unknown id answers `false` — the subscription-run
 * policy then refuses the run rather than trusting an unregistered mode.
 */
export function orchestratorIsolatesWorkloads(id: ExecutionMode): boolean {
  return ORCHESTRATORS.get(id)?.isolatesWorkloads ?? false;
}

/**
 * Whether the backend registered under `id` can run sidecar-only
 * workloads (connect-runs). Fail-closed on unknown ids.
 */
export function orchestratorSupportsSidecarOnly(id: ExecutionMode): boolean {
  return ORCHESTRATORS.get(id)?.supportsSidecarOnly ?? false;
}

/** Ids of the backends that provide per-run isolation (sorted). */
export function isolatingOrchestratorIds(): ExecutionMode[] {
  return [...ORCHESTRATORS.entries()]
    .filter(([, registration]) => registration.isolatesWorkloads)
    .map(([id]) => id)
    .sort();
}

/**
 * Test seam — restore the registry to core-only backends (docker, process),
 * dropping any test or module registrations. Never call in production code:
 * module registrations happen exactly once at load time and must survive
 * for the process lifetime.
 */
export function _resetOrchestratorRegistryForTesting(): void {
  ORCHESTRATORS.clear();
  registerCoreOrchestrators();
}
