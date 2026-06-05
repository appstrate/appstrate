// SPDX-License-Identifier: Apache-2.0

/**
 * Platform runtime capability types — structural contracts shared between
 * apps/api and the published @appstrate/core package (container orchestrator,
 * run/run-log DTOs, realtime event shape, inline-run body, pub/sub).
 *
 * This file is type-only (no runtime code). The concrete implementations live
 * in apps/api; consumers reference these shapes without reaching into apps/api
 * internals.
 */

import type { SidecarLaunchSpec } from "./sidecar-types.ts";

// Re-export sidecar config types from the dedicated module for convenience.
export type { SidecarConfig, SidecarLaunchSpec, LlmProxyConfig } from "./sidecar-types.ts";

// ---------------------------------------------------------------------------
// Actor — who initiated an operation
// ---------------------------------------------------------------------------

/**
 * Identifies who initiated a run or API call — a dashboard user (BA user)
 * or an end-user impersonated via `Appstrate-User`. Kept as a thin
 * discriminated union so modules can narrow by `type` without importing
 * `@appstrate/connect`.
 */
export type Actor = { type: "user"; id: string } | { type: "end_user"; id: string };

// ---------------------------------------------------------------------------
// Public DTO shapes — stable fields of platform entities
//
// These types expose the minimum fields external modules can rely on at the
// package boundary. Concrete apps/api rows carry more fields; width
// subtyping makes them assignable to these narrower shapes. `result` and
// nested payloads are typed as `unknown` — modules cast at the call site
// when they need the richer shape.
// ---------------------------------------------------------------------------

/**
 * Stable public fields of a run row. Narrower than the internal row —
 * exposes what external modules need to reason about a run lifecycle
 * without leaking scheduler/actor/api-key internals.
 *
 * `result` is `unknown` because the shape depends on the agent and is
 * application-defined; consumers cast at the call site.
 */
export interface Run {
  readonly id: string;
  readonly status: string;
  readonly orgId: string;
  readonly applicationId: string;
  /**
   * Source agent. NULL when the source agent has been deleted — the run
   * row survives via `runs.package_id ON DELETE SET NULL` (see migration
   * 0017_decouple_runs_from_packages.sql). Modules reading `packageId` to
   * route a run to a specific agent must handle null (e.g. skip, or read
   * the denormalized snapshot exposed by callers when relevant).
   */
  readonly packageId: string | null;
  readonly result: unknown;
  readonly error: string | null;
}

/**
 * Stable public fields of a run log row. `data` is the free-form JSON
 * payload emitted alongside the line. Log-level literals are kept as
 * `string` (rather than a union) so future extensions are non-breaking.
 */
export interface RunLog {
  readonly id: number;
  readonly runId: string;
  readonly level: string;
  readonly type: string;
  readonly event: string | null;
  readonly message: string | null;
  readonly data: unknown;
  readonly createdAt: Date;
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

export interface WorkloadSpec {
  runId: string;
  role: string;
  image: string;
  env: Record<string, string>;
  resources: WorkloadResources;
  /**
   * Place this workload on the egress network (direct internet + platform
   * reachability) instead of the internal isolation boundary. Set for the
   * agent in `skipSidecar` runs: with no sidecar there is no egress proxy,
   * so the agent must reach the upstream LLM and the platform sink itself —
   * the same network treatment the orchestrator gives the sidecar. Ignored
   * by orchestrators without network isolation (e.g. the process orchestrator).
   */
  egress?: boolean;
}

export interface IsolationBoundary {
  readonly id: string;
  readonly name: string;
  /**
   * Per-run shared workspace handle. Backs `/workspace` on the agent
   * container and (opt-in via mcp-server `_meta["dev.appstrate/workspace"]`)
   * on per-integration runner containers. Shape varies by orchestrator:
   *
   *   - Docker: `{ kind: "volume", name: string }` — a named Docker
   *     volume created alongside the per-run network.
   *   - Process: `{ kind: "directory", path: string }` — a host
   *     directory under `os.tmpdir()/appstrate-ws-<runId>/`.
   *
   * Non-optional: every built-in orchestrator provides a handle. The
   * `WorkspaceHandle` union (not an optional field) is what keeps the
   * door open for a future orchestrator to add a third shape without
   * touching call sites that already branch on `kind`.
   */
  readonly workspace: WorkspaceHandle;
}

/**
 * Opaque handle that the orchestrator hands to its sidecar so the
 * sidecar can ask the integration runtime adapter to mount the same
 * workspace under a runner container. The shape is orchestrator-specific
 * — sidecar code branches on `kind` (not on `RUN_ADAPTER`) so a future
 * orchestrator can introduce a third workspace shape without touching
 * the adapter dispatch.
 */
export type WorkspaceHandle =
  | { readonly kind: "volume"; readonly name: string }
  | { readonly kind: "directory"; readonly path: string };

export interface CleanupReport {
  workloads: number;
  isolationBoundaries: number;
  /**
   * Per-run shared workspaces (Docker named volumes or host
   * directories under `os.tmpdir()`) reclaimed by the sweep. Counted
   * alongside boundaries so operators see the full per-run resource
   * footprint, not just network leaks.
   */
  workspaces: number;
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
   * Create + start a sidecar container for the given run. The orchestrator
   * resolves the platform API URL from its own context (see
   * {@link resolvePlatformApiUrl}) — callers do not supply it.
   */
  createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle>;

  /**
   * Create a workload (agent). Does NOT start it. The agent self-provisions
   * its workspace at startup by fetching from the platform (the AFPS bundle
   * and any input documents), so workspace contents are not delivered through
   * this spec.
   */
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

  /**
   * Base URL the agent workload should use to reach the platform API.
   * Docker: Docker-network hostname (when platform is containerized) or
   * `host.docker.internal` (local dev). Process: `http://localhost:{PORT}`.
   *
   * Consumed by the unified-runner protocol — the container reads
   * `APPSTRATE_SINK_URL` composed from this base + `/api/runs/:id/events`.
   */
  resolvePlatformApiUrl(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Realtime SSE — event shape
// ---------------------------------------------------------------------------

/** Event delivered to realtime subscribers (matches the SSE wire format). */
export interface RealtimeEvent {
  event: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Inline run — request body
// ---------------------------------------------------------------------------

/** Body accepted by the inline-run preflight/pipeline. All fields optional and validated downstream. */
export interface InlineRunBody {
  manifest?: unknown;
  prompt?: unknown;
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
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
