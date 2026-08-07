// SPDX-License-Identifier: Apache-2.0

/**
 * Platform runtime capability types — structural contracts shared between
 * apps/api and the published @appstrate/core package (container orchestrator,
 * realtime event shape, inline-run body, pub/sub).
 *
 * This file is type-only (no runtime code). The concrete implementations live
 * in apps/api; consumers reference these shapes without reaching into apps/api
 * internals.
 */

import type { SidecarLaunchSpec } from "./sidecar-types.ts";
import type { ModelGenerationSettings } from "./model-generation.ts";

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
 * How an orchestrator applies the agent allocation carried by
 * {@link WorkloadSpec.resources}. Absent capabilities mean the backend does
 * not apply the allocation.
 */
export interface OrchestratorAgentResourceCapabilities {
  /** Hard per-workload limits, or capacity used to size a wider boundary. */
  readonly semantics: "limits" | "sizing";
  /** Optional agent CPU ceiling imposed by the backend's own sizing model. */
  readonly maxAgentCpu?: number;
  /**
   * Optional percentage of guest RAM used to cap a RAM-backed writable root
   * that includes the agent workspace. Lets a backend surface its filesystem
   * budget without core knowing the backend id or implementation.
   */
  readonly writableRootTmpfsPercent?: number;
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
  /** Resource semantics declared explicitly; absence fails closed. */
  readonly agentResources?: OrchestratorAgentResourceCapabilities;
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
  generation?: ModelGenerationSettings;
  proxyId?: string | null;
  /**
   * Per-integration connection picks for THIS run (flat map:
   * `{ "@scope/integration": "<connection_id>" }`, resolver mechanism #2).
   * Read by the preflight so a caller that disambiguates a
   * `must_choose_connection` 412 by re-posting its pick gets past the readiness
   * gate — the same recovery loop the cataloged run route supports.
   *
   * Optional but NOT nullable: both run routes reject an explicit `null` on the
   * wire, so a published type promising `| null` would describe a body the
   * server refuses. Omit the field to mean "no picks".
   */
  connection_overrides?: Record<string, string>;
  /**
   * Per-dependency version overrides for THIS run. Keys name declared skill
   * or integration dependencies; `"draft"` selects the org-visible working
   * copy and any other accepted selector replaces the manifest pin against
   * published versions. Run-scoped only and persisted on the resulting run.
   */
  dependency_overrides?: Record<string, string>;
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
