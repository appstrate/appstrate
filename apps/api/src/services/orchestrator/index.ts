// SPDX-License-Identifier: Apache-2.0

import { getExecutionMode } from "../../infra/mode.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";
import { FirecrackerOrchestrator } from "./firecracker/firecracker-orchestrator.ts";
import { registerOrchestrator, selectOrchestrator } from "./registry.ts";
import type { RunOrchestrator } from "@appstrate/core/platform-types";

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

// Built-in execution backends. External backends would register the same
// way — the registry is keyed by RUN_ADAPTER value, no if/else per type.
registerOrchestrator({ id: "docker", create: () => new DockerOrchestrator() });
registerOrchestrator({ id: "process", create: () => new ProcessOrchestrator() });
registerOrchestrator({ id: "firecracker", create: () => new FirecrackerOrchestrator() });

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
