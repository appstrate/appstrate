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
// Actor — who initiated an operation
// ---------------------------------------------------------------------------

/**
 * Identifies who initiated a run or API call — a dashboard member (BA user)
 * or an end-user impersonated via `Appstrate-User`. Kept as a thin
 * discriminated union so modules can narrow by `type` without importing
 * `@appstrate/connect`.
 */
export type Actor = { type: "member"; id: string } | { type: "end_user"; id: string };

// ---------------------------------------------------------------------------
// Public DTO shapes — stable fields of platform entities
//
// These types expose the minimum fields external modules can rely on at the
// package boundary. Concrete apps/api rows carry more fields; width
// subtyping makes them assignable to these narrower shapes. `manifest` and
// nested payloads are typed as `unknown` — modules cast at the call site
// when they need the richer shape.
// ---------------------------------------------------------------------------

/** Stable public fields of a loaded package (agent, skill, tool, provider). */
export interface PlatformPackage {
  readonly id: string;
  readonly source: "system" | "local";
  /** Opaque manifest — cast to `AgentManifest` or similar at the call site. */
  readonly manifest: unknown;
}

/** Stable public fields of a resolved model — what modules need to route LLM traffic. */
export interface PlatformModel {
  readonly api: string;
  readonly modelId: string;
  readonly baseUrl: string;
}

/** Stable public fields of an application row. */
export interface PlatformApplication {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** A user's connections grouped by provider, then by org — shape returned by `connections.listAllForActor`. */
export interface PlatformConnectionProviderGroup {
  readonly providerId: string;
  readonly displayName: string;
  readonly logo: string;
  readonly totalConnections: number;
  readonly orgs: ReadonlyArray<{
    readonly orgId: string;
    readonly orgName: string;
    /** Connection entries — cast to `UserConnectionEntry` (from shared-types) at the call site. */
    readonly connections: ReadonlyArray<unknown>;
  }>;
}

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
