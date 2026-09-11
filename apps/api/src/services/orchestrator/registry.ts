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

import type {
  OrchestratorAgentResourceCapabilities,
  RunOrchestrator,
  OrchestratorRegistration,
} from "@appstrate/core/platform-types";
import type { ExecutionMode } from "../../infra/mode.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";

interface OwnedRegistration extends OrchestratorRegistration {
  /** Module id that contributed this backend ("core" for built-in ones). */
  readonly owner: string;
}

const ORCHESTRATORS = new Map<string, OwnedRegistration>();
const MAX_AGENT_CPU = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000_000);

function validateAgentResources(id: string, owner: string, capabilities: unknown): void {
  if (capabilities === undefined) return;
  const prefix = `Invalid agentResources for orchestrator ${JSON.stringify(id)} from ${JSON.stringify(owner)}`;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new Error(`${prefix}: expected an object.`);
  }

  const { semantics, maxAgentCpu, writableRootTmpfsPercent } = capabilities as Record<
    string,
    unknown
  >;
  if (semantics !== "limits" && semantics !== "sizing") {
    throw new Error(`${prefix}: semantics must be "limits" or "sizing".`);
  }
  if (
    maxAgentCpu !== undefined &&
    (!Number.isSafeInteger(maxAgentCpu) ||
      (maxAgentCpu as number) <= 0 ||
      (maxAgentCpu as number) > MAX_AGENT_CPU)
  ) {
    throw new Error(
      `${prefix}: maxAgentCpu must be a positive safe integer whose nanoCPU conversion is safe.`,
    );
  }
  if (
    writableRootTmpfsPercent !== undefined &&
    (!Number.isSafeInteger(writableRootTmpfsPercent) ||
      (writableRootTmpfsPercent as number) < 1 ||
      (writableRootTmpfsPercent as number) > 100)
  ) {
    throw new Error(`${prefix}: writableRootTmpfsPercent must be a safe integer from 1 to 100.`);
  }
}

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
  validateAgentResources(id, owner, registration.agentResources);
  ORCHESTRATORS.set(id, { ...registration, owner });
}

function registerCoreOrchestrators(): void {
  registerOrchestrator(
    "docker",
    {
      isolatesWorkloads: true,
      supportsSidecarOnly: true,
      agentResources: { semantics: "limits" },
      // `createIsolationBoundary` creates the per-run workspace volume with
      // tmpfs driver options sized from `WORKSPACE_TMPFS_SIZE_MB` (0 = plain
      // disk-backed volume, and the accessor reports the 0 verbatim).
      appliesWorkspaceTmpfsCap: true,
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

/**
 * Resource semantics declared by the backend registered under `id`.
 * Fail-closed: process, unknown, and undeclared future backends return
 * `undefined`.
 */
export function orchestratorAgentResources(
  id: ExecutionMode,
): OrchestratorAgentResourceCapabilities | undefined {
  return ORCHESTRATORS.get(id)?.agentResources;
}

/**
 * Whether the backend registered under `id` sizes the run workspace from
 * `WORKSPACE_TMPFS_SIZE_MB`. Fail-closed: an unknown or undeclared backend
 * answers `false`, so the prompt stays silent rather than claiming a cap the
 * backend never applies.
 */
export function orchestratorAppliesWorkspaceTmpfsCap(id: ExecutionMode): boolean {
  return ORCHESTRATORS.get(id)?.appliesWorkspaceTmpfsCap ?? false;
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
