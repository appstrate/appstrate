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

/**
 * A platform-resolved companion capability that must exist inside the run
 * boundary. Values are computed from validated package metadata and operator
 * policy; orchestrators never trust raw manifest resource requests.
 */
export type ExecutionCapabilityRequirement = {
  readonly kind: "browser";
  readonly profile: "standard";
  readonly instances: number;
};

export interface ExecutionRequirements {
  readonly capabilities: readonly ExecutionCapabilityRequirement[];
  /** Additional boundary-wide resources beyond the agent and sidecar. */
  readonly supplementalResources: WorkloadResources;
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
  /**
   * Hard, last-resort lifetime ceiling (seconds) an orchestrator MAY
   * enforce host-side — kill the workload with crash semantics once it
   * outlives this bound. Only matters when the platform's own timeout can
   * no longer reach the workload (platform death or platform↔daemon
   * partition); callers size it comfortably ABOVE the platform safety net
   * so it never fires first on a healthy deployment. Additive and
   * optional — orchestrators without host-side enforcement ignore it.
   */
  maxLifetimeSeconds?: number;
}

/**
 * How the AGENT workload reaches its run's sidecar. Resolved by the
 * orchestrator at boundary creation — the shape of "where is the sidecar"
 * is a pure topology decision (Docker DNS alias, host loopback port,
 * in-guest loopback for microVMs) and must never leak into
 * orchestrator-agnostic launch code as magic strings.
 *
 * Always present on a boundary: the endpoints describe where a sidecar
 * WOULD live for this run. Runs that skip the sidecar simply never read
 * them.
 */
export interface SidecarEndpoints {
  /** Base URL of the sidecar's HTTP surface (`/mcp`, `/health`) as seen from the agent. */
  readonly sidecarUrl: string;
  /** Placeholder-substituting LLM reverse proxy (`/llm`) as seen from the agent. */
  readonly llmProxyUrl: string;
  /** Egress forward proxy (HTTP CONNECT) as seen from the agent. */
  readonly forwardProxyUrl: string;
  /** Comma-separated hosts the agent must exclude from the forward proxy. */
  readonly noProxy: string;
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
   *   - Firecracker: `{ kind: "directory", path: "/workspace" }` — a
   *     GUEST-side path. The sidecar and integration runners execute
   *     inside the same microVM as the agent, so from every consumer's
   *     perspective the workspace is a plain directory.
   *
   * Non-optional: every built-in orchestrator provides a handle. The
   * `WorkspaceHandle` union (not an optional field) is what keeps the
   * door open for a future orchestrator to add a third shape without
   * touching call sites that already branch on `kind`.
   */
  readonly workspace: WorkspaceHandle;
  /**
   * Agent-visible sidecar endpoints for this run. See {@link SidecarEndpoints}.
   */
  readonly sidecarEndpoints: SidecarEndpoints;
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

/** Optional hints for {@link RunOrchestrator.createIsolationBoundary}. */
export interface IsolationBoundaryOptions {
  /**
   * The run will never launch a sidecar (no integrations, static API key,
   * no proxy, no alias). Lets port-allocating backends skip reserving a
   * sidecar port the run will never bind — the boundary's
   * `sidecarEndpoints` are then placeholders that must not be dialled.
   */
  skipSidecar?: boolean;
  /**
   * Capabilities and supplemental resources resolved before the boundary is
   * created. Backends must fail closed when a required capability cannot be
   * provisioned; silently dropping this object would under-size Firecracker
   * guests and break browser isolation.
   */
  requirements?: ExecutionRequirements;
}

// ---------------------------------------------------------------------------
// RunOrchestrator — structural contract
// ---------------------------------------------------------------------------

/**
 * Execution backend for agent runs. Implementations decide what a
 * "workload" physically is — a Docker container, a host subprocess, or a
 * process inside a per-run Firecracker microVM — behind one uniform
 * lifecycle contract. Selected by `RUN_ADAPTER` through the orchestrator
 * registry (`apps/api/src/services/orchestrator/registry.ts`).
 */
export interface RunOrchestrator {
  /** Init one-shot: pool init, platform detection, etc. */
  initialize(): Promise<void>;

  /** Graceful shutdown: drain pool, release resources. */
  shutdown(): Promise<void>;

  /** Clean up orphaned workloads/networks from a previous crash. */
  cleanupOrphans(): Promise<CleanupReport>;

  /** Ensure images are locally available (pull if missing/outdated). No-op when not applicable. */
  ensureImages(images: string[]): Promise<void>;

  /** Create an isolated environment for a run. Docker: bridge network. K8s: namespace. */
  createIsolationBoundary(
    runId: string,
    opts?: IsolationBoundaryOptions,
  ): Promise<IsolationBoundary>;

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

/**
 * Registration entry for an execution backend, keyed by `RUN_ADAPTER` value
 * in the orchestrator registry. Core registers its own backends (docker,
 * process); modules contribute additional ones via
 * `AppstrateModule.orchestrators()`. A backend's security capabilities are
 * declared here — the platform trusts the declaration (a module listed in
 * `MODULES` is operator-installed code), but unknown ids always degrade to
 * "no capability" (fail-closed).
 */
export interface OrchestratorRegistration {
  /**
   * Whether this backend places each run inside a real isolation boundary
   * (container, microVM) that keeps run credentials out of the host API
   * process. Security-sensitive: the subscription-run policy refuses
   * OAuth-subscription agent runs on any backend that does not declare
   * this — a new backend is untrusted until it opts in explicitly.
   */
  readonly isolatesWorkloads: boolean;
  /**
   * Whether this backend can run a sidecar-only workload (no agent) —
   * the shape connect-runs use. Backends whose workload lifecycle is
   * driven by the agent (e.g. a one-shot microVM boot) cannot: a
   * sidecar-only launch would silently never start. Connect fails fast
   * instead.
   */
  readonly supportsSidecarOnly: boolean;
  /** Build a fresh orchestrator instance. Called once per process (singleton held by the registry consumer). */
  readonly create: () => RunOrchestrator;
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
