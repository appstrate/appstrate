import type { ContainerOrchestrator } from "./interface.ts";
import { DockerOrchestrator } from "./docker-orchestrator.ts";

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
  // Future: switch on env var for K8s support
  return new DockerOrchestrator();
}
