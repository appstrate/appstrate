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
  /**
   * Whether this backend places each run inside a real isolation boundary
   * (container, microVM) that keeps run credentials out of the host API
   * process. Security-sensitive: the subscription-run policy refuses
   * OAuth-subscription agent runs on any backend that does not declare
   * this — a new backend is untrusted until it opts in explicitly.
   */
  readonly isolatesWorkloads: boolean;
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

/**
 * Whether the backend registered under `id` provides per-run isolation.
 * Fail-closed: an unknown id answers `false` — the subscription-run
 * policy then refuses the run rather than trusting an unregistered mode.
 */
export function orchestratorIsolatesWorkloads(id: string): boolean {
  return registry.get(id)?.isolatesWorkloads ?? false;
}

/** Ids of the backends that provide per-run isolation (sorted). */
export function isolatingOrchestratorIds(): string[] {
  return [...registry.values()]
    .filter((registration) => registration.isolatesWorkloads)
    .map((registration) => registration.id)
    .sort();
}
