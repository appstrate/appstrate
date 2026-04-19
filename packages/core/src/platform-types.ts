// SPDX-License-Identifier: Apache-2.0

/**
 * Platform runtime capability types — the structural contract for services
 * injected into modules via `ModuleInitContext.services`.
 *
 * This file is type-only (no runtime code). The concrete implementations live
 * in apps/api; external modules consume these shapes through the published
 * @appstrate/core package without reaching into apps/api internals.
 */

import type { SidecarConfig } from "./sidecar-types.ts";

// Re-export sidecar config types from the dedicated module for convenience.
export type { SidecarConfig, LlmProxyConfig } from "./sidecar-types.ts";

// ---------------------------------------------------------------------------
// Workload / orchestrator value types
// ---------------------------------------------------------------------------

export interface WorkloadHandle {
  readonly id: string;
  readonly runId: string;
  readonly role: string;
}

export interface WorkloadResources {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit?: number;
}

export interface InjectableFile {
  name: string;
  content: Buffer;
}

export interface WorkloadSpec {
  runId: string;
  role: string;
  image: string;
  env: Record<string, string>;
  resources: WorkloadResources;
  files?: { items: InjectableFile[]; targetDir: string };
}

export interface IsolationBoundary {
  readonly id: string;
  readonly name: string;
}

export interface CleanupReport {
  workloads: number;
  isolationBoundaries: number;
}

export type StopResult = "stopped" | "not_found" | "already_stopped";

// ---------------------------------------------------------------------------
// ContainerOrchestrator — structural contract
// ---------------------------------------------------------------------------

export interface ContainerOrchestrator {
  /** Init one-shot: pool init, platform detection, etc. */
  initialize(): Promise<void>;

  /** Graceful shutdown: drain pool, release resources. */
  shutdown(): Promise<void>;

  /** Clean up orphaned workloads/networks from a previous crash. */
  cleanupOrphans(): Promise<CleanupReport>;

  /** Ensure images are locally available (pull if missing/outdated). No-op when not applicable. */
  ensureImages(images: string[]): Promise<void>;

  /** Create an isolated environment for a run. Docker: bridge network. K8s: namespace. */
  createIsolationBoundary(runId: string): Promise<IsolationBoundary>;

  /** Remove an isolated environment. Idempotent. */
  removeIsolationBoundary(boundary: IsolationBoundary): Promise<void>;

  /**
   * Create a ready-to-use sidecar (from pool or fresh).
   * Internally handles: pool acquisition, fresh creation, platform network,
   * ExtraHosts, port mapping, health check.
   */
  createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    config: SidecarConfig,
  ): Promise<WorkloadHandle>;

  /** Create a workload (agent). Does NOT start it — file injection included in the spec. */
  createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle>;

  /** Start a created workload. */
  startWorkload(handle: WorkloadHandle): Promise<void>;

  /** Stop a workload. Idempotent. */
  stopWorkload(handle: WorkloadHandle, timeoutSeconds?: number): Promise<void>;

  /** Remove a workload. Idempotent. */
  removeWorkload(handle: WorkloadHandle): Promise<void>;

  /** Wait for a workload to finish. Returns the exit code. */
  waitForExit(handle: WorkloadHandle): Promise<number>;

  /** Stream logs from a running workload. Format-agnostic (text line by line). */
  streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string>;

  /** Stop ALL workloads for a run by ID. For cancel. */
  stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult>;
}

// ---------------------------------------------------------------------------
// Pub/Sub — structural contract
// ---------------------------------------------------------------------------

/**
 * Abstract Pub/Sub interface.
 * Implementations: Redis (multi-instance) and local EventEmitter (single-instance).
 */
export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  shutdown(): Promise<void>;
}
