// SPDX-License-Identifier: Apache-2.0

import { getExecutionMode } from "../../infra/mode.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";
import type { ContainerOrchestrator } from "@appstrate/core/platform-types";

export type {
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadResources,
  InjectableFile,
  WorkloadSpec,
  IsolationBoundary,
  CleanupReport,
  StopResult,
  SidecarConfig,
  LlmProxyConfig,
} from "@appstrate/core/platform-types";

let instance: ContainerOrchestrator | undefined;

export function getOrchestrator(): ContainerOrchestrator {
  if (!instance) {
    instance = createOrchestrator();
  }
  return instance;
}

function createOrchestrator(): ContainerOrchestrator {
  const mode = getExecutionMode();
  if (mode === "process") return new ProcessOrchestrator();
  return new DockerOrchestrator();
}
