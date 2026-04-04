// SPDX-License-Identifier: Apache-2.0

import { getExecutionMode } from "../../infra/mode.ts";
import type { ContainerOrchestrator } from "./interface.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";
import { ProcessOrchestrator } from "./process-orchestrator.ts";

export type { ContainerOrchestrator } from "./interface.ts";
export type * from "./types.ts";

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
