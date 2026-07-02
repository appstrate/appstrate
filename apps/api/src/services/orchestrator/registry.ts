// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator registry — uniform id→factory resolution for execution
 * backends, mirroring the sidecar's `registerIntegrationRuntimeAdapter`
 * pattern. Built-ins (docker, process, firecracker) register from
 * `./index.ts`; selection is purely by `RUN_ADAPTER` value — no
 * auto-probing, no per-backend `if` branches at call sites.
 */

import type { RunOrchestrator } from "@appstrate/core/platform-types";

export interface OrchestratorRegistration {
  /** `RUN_ADAPTER` value this backend answers to. */
  readonly id: string;
  /** Build a fresh orchestrator instance. Called once per process (singleton held by index.ts). */
  readonly create: () => RunOrchestrator;
}

const registry = new Map<string, OrchestratorRegistration>();

export function registerOrchestrator(registration: OrchestratorRegistration): void {
  if (registry.has(registration.id)) {
    throw new Error(`Orchestrator "${registration.id}" is already registered`);
  }
  registry.set(registration.id, registration);
}

export function selectOrchestrator(id: string): RunOrchestrator {
  const registration = registry.get(id);
  if (!registration) {
    const known = [...registry.keys()].sort().join(", ");
    throw new Error(`Unknown RUN_ADAPTER "${id}" — registered orchestrators: ${known}`);
  }
  return registration.create();
}

/** Registered backend ids, for diagnostics and tests. */
export function listOrchestratorIds(): string[] {
  return [...registry.keys()].sort();
}
