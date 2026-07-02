// SPDX-License-Identifier: Apache-2.0

import { getExecutionMode } from "../../infra/mode.ts";
import { selectOrchestrator } from "./registry.ts";
import type { RunOrchestrator } from "@appstrate/core/platform-types";

export {
  orchestratorIsolatesWorkloads,
  orchestratorSupportsSidecarOnly,
  isolatingOrchestratorIds,
} from "./registry.ts";

export type {
  RunOrchestrator,
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadResources,
  WorkloadSpec,
  IsolationBoundary,
  SidecarEndpoints,
  CleanupReport,
  StopResult,
  SidecarConfig,
  LlmProxyConfig,
} from "@appstrate/core/platform-types";

let instance: RunOrchestrator | undefined;

export function getOrchestrator(): RunOrchestrator {
  if (!instance) {
    instance = selectOrchestrator(getExecutionMode());
  }
  return instance;
}

/**
 * Test seam — swap the orchestrator singleton for a fake so route-level
 * integration tests can exercise the full run kickoff without a real
 * container runtime (same pattern as `_setRunLimitsForTesting`). Pass
 * `null` to reset; the next `getOrchestrator()` re-creates the real one.
 * Never call in production code.
 */
export function _setOrchestratorForTesting(orchestrator: RunOrchestrator | null): void {
  instance = orchestrator ?? undefined;
}
