// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2a — integration spawn orchestrator.
 *
 * Top-level glue between the agent run lifecycle and the per-integration
 * MCP subprocesses. Reads the agent's `dependencies.integrations`, spawns
 * each MCP server in parallel through an injected `spawn` callback, and
 * surfaces a deterministic teardown.
 *
 * Pure orchestration — no `Bun.spawn`, no Docker, no filesystem. The
 * injected `spawn` returns whatever `ChildHandle` the caller's transport
 * produces, and the orchestrator threads it through the
 * {@link superviseProcess} supervisor for automatic restart-on-crash
 * (proposal §5.4.2). Same hermetic-test invariant as Phase 1.1.
 *
 * Lifecycle:
 *
 *   1. {@link spawnIntegrations} — accepts N integration descriptors;
 *      builds N supervised processes in parallel; resolves once all
 *      first-time spawns have completed (or one fatally fails to start,
 *      at which point already-started ones are torn down).
 *   2. {@link IntegrationOrchestrator.signalCredentialRefresh} — sends
 *      SIGHUP to integrations declaring `afpsAware: true` after an
 *      OAuth credential refresh (proposal §5.4.2).
 *   3. {@link IntegrationOrchestrator.shutdown} — stops every supervisor
 *      in parallel; resolves when all teardowns complete. Idempotent.
 *
 * What lives elsewhere:
 *
 *   - Actual subprocess spawn → `runtime-pi/sidecar` (uses `Bun.spawn` +
 *     SubprocessTransport).
 *   - Manifest validation        → `@appstrate/core/integration`.
 *   - Credential resolution      → `./integration-credentials.ts`.
 *   - Server type → spawn argv   → `./integration-runtime.ts`.
 *   - Restart-with-backoff       → `./restart-supervisor.ts`.
 */

import {
  superviseProcess,
  type ChildHandle,
  type SupervisorEvent,
  type SupervisorOptions,
  type SupervisorOutcome,
  type SupervisedProcess,
} from "./restart-supervisor.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/**
 * One integration to spawn. The orchestrator does not introspect the
 * manifest itself — the caller is expected to have already run
 * `validateIntegrationServer`, `resolveIntegrationServer`,
 * `buildSpawnCommand`, and `resolveIntegrationCredentials` upstream and
 * passes the resolved bundle here.
 */
export interface IntegrationSpawnRequest {
  /** Stable id for this integration (typically `package.id` from DB). */
  integrationId: string;
  /** Stable display namespace (e.g. last segment of `@scope/name`). */
  namespace: string;
  /** Whether the package declares `afpsAware: true` (controls SIGHUP). */
  afpsAware?: boolean;
  /**
   * Per-attempt spawn factory. Called once on initial spawn and again
   * on every restart. The factory must apply the platform-side env
   * (proxy 6-tuple + CA path + credential delivery) before invoking
   * the actual transport.
   */
  spawn: () => Promise<ChildHandle>;
  /** Override the global supervisor schedule for this integration. */
  supervisorOptions?: Pick<SupervisorOptions, "schedule" | "sleep" | "now">;
}

/** Live state of one supervised integration. */
export interface RunningIntegration {
  integrationId: string;
  namespace: string;
  process: SupervisedProcess;
  /** True when the very first spawn succeeded. */
  initialised: boolean;
  /** Resolves with the supervisor outcome once the integration is fully dead. */
  done: Promise<SupervisorOutcome>;
}

/** Event sink for the orchestrator (telemetry, audit log). */
export interface IntegrationOrchestratorEvent extends SupervisorEvent {
  integrationId: string;
  namespace: string;
}

/** Options accepted by {@link spawnIntegrations}. */
export interface SpawnIntegrationsOptions {
  /** Supervisor schedule default (per-request override wins). */
  supervisorSchedule?: readonly number[];
  /** Telemetry sink — every supervisor event is forwarded with namespace + id. */
  onEvent?: (event: IntegrationOrchestratorEvent) => void;
  /** Custom kill-signal helper — see {@link IntegrationOrchestrator.signalCredentialRefresh}. */
  signaller?: SignalDispatcher;
}

/**
 * Abstraction for delivering POSIX signals to a running MCP subprocess.
 * The orchestrator does not own the subprocess handle — the caller's
 * transport does — so signalling is delegated.
 */
export interface SignalDispatcher {
  /**
   * Send `signal` to the subprocess backing `integrationId`. Returns
   * `true` when the signal was delivered, `false` when the integration
   * is not currently running. Errors should bubble — the orchestrator
   * logs but does not silently swallow.
   */
  signal(integrationId: string, signal: "SIGHUP" | "SIGTERM"): Promise<boolean>;
}

// ─────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────

/** Stateful handle returned by {@link spawnIntegrations}. */
export interface IntegrationOrchestrator {
  /** All integrations that completed initial spawn. */
  readonly running: ReadonlyArray<RunningIntegration>;
  /** Map view, keyed by `integrationId`. */
  get(integrationId: string): RunningIntegration | undefined;
  /**
   * Send SIGHUP to every integration declaring `afpsAware: true`. Used
   * by the credential refresh path (§5.4.2) so the MCP server can
   * re-read its credential file without restart. No-op for
   * non-afpsAware integrations — they continue to receive injected
   * credentials via the credential proxy.
   *
   * When `targets` is provided, the signal is sent only to those
   * integration ids (intersected with the afpsAware set).
   */
  signalCredentialRefresh(targets?: ReadonlyArray<string>): Promise<{
    sent: string[];
    skipped: string[];
  }>;
  /**
   * Stop every supervised integration. Resolves once every supervisor's
   * `stop()` has settled — i.e. once every child subprocess has either
   * exited gracefully or been killed. Idempotent.
   */
  shutdown(): Promise<void>;
}

/**
 * Build the orchestrator and spawn every requested integration in
 * parallel. The returned promise resolves once every supervisor has
 * settled its **first** spawn (either successful or a permanent failure).
 *
 * On a permanent first-spawn failure (i.e. the supervisor immediately
 * runs through its full schedule), the orchestrator tears down every
 * other integration that started successfully and rethrows the
 * underlying error. This keeps the agent run from limping along with
 * half its integrations missing.
 */
export async function spawnIntegrations(
  requests: ReadonlyArray<IntegrationSpawnRequest>,
  options: SpawnIntegrationsOptions = {},
): Promise<IntegrationOrchestrator> {
  // Pre-validate namespace uniqueness up-front — colliding namespaces
  // are auto-disambiguated by McpHost, but the orchestrator surfaces
  // the unmangled requests for telemetry. (McpHost does its own
  // suffixing on register; this check is for "two different requests
  // happen to share the same `integrationId`" — operator config error).
  const seenIds = new Set<string>();
  for (const req of requests) {
    if (seenIds.has(req.integrationId)) {
      throw new Error(
        `spawnIntegrations: duplicate integrationId '${req.integrationId}' in the request set`,
      );
    }
    seenIds.add(req.integrationId);
  }

  const onEvent = options.onEvent ?? noopEvent;
  const signaller = options.signaller;

  const supervised: RunningIntegration[] = [];

  // Spawn every supervisor in parallel; resolve initialisation status
  // (did the first spawn succeed?) via a per-request promise.
  const initialisationPromises = requests.map((req) => {
    let initSettled = false;
    let initResolve!: () => void;
    let initReject!: (err: unknown) => void;
    const initPromise = new Promise<void>((res, rej) => {
      initResolve = res;
      initReject = rej;
    });

    const proc = superviseProcess(req.spawn, {
      schedule: req.supervisorOptions?.schedule ?? options.supervisorSchedule ?? undefined,
      ...(req.supervisorOptions?.sleep ? { sleep: req.supervisorOptions.sleep } : {}),
      ...(req.supervisorOptions?.now ? { now: req.supervisorOptions.now } : {}),
      onEvent: (e) => {
        // Mark "initialised" the moment the first spawn-success arrives.
        if (e.type === "spawn-success" && !initSettled && e.attempt === 1) {
          initSettled = true;
          entry.initialised = true;
          initResolve();
        }
        // Bubble events with namespace/id annotation.
        onEvent({ ...e, integrationId: req.integrationId, namespace: req.namespace });
      },
    });

    const entry: RunningIntegration = {
      integrationId: req.integrationId,
      namespace: req.namespace,
      process: proc,
      initialised: false,
      done: proc.done,
    };

    // If the supervisor finishes (max-restarts) before init ever
    // succeeded, reject the init promise so the parent rejects.
    proc.done.then((outcome) => {
      if (!initSettled) {
        initSettled = true;
        initReject(new SpawnFailureError(req.integrationId, req.namespace, outcome.lastExit));
      }
    });

    supervised.push(entry);
    return initPromise;
  });

  try {
    await Promise.all(initialisationPromises);
  } catch (firstFailure) {
    // Tear down anything that did start, then rethrow.
    await Promise.allSettled(supervised.map((s) => s.process.stop()));
    throw firstFailure;
  }

  const byId = new Map<string, RunningIntegration>();
  for (const r of supervised) byId.set(r.integrationId, r);

  let shutdownPromise: Promise<void> | null = null;

  const orchestrator: IntegrationOrchestrator = {
    get running() {
      return supervised;
    },
    get(integrationId) {
      return byId.get(integrationId);
    },
    async signalCredentialRefresh(targets) {
      if (!signaller) {
        // No transport-side wire to send signals — return everyone
        // as "skipped" to make the caller's audit log explicit.
        return { sent: [], skipped: supervised.map((r) => r.integrationId) };
      }
      const candidates = targets
        ? requests.filter((r) => targets.includes(r.integrationId))
        : requests;
      const sent: string[] = [];
      const skipped: string[] = [];
      for (const req of candidates) {
        if (!req.afpsAware) {
          skipped.push(req.integrationId);
          continue;
        }
        try {
          const delivered = await signaller.signal(req.integrationId, "SIGHUP");
          if (delivered) sent.push(req.integrationId);
          else skipped.push(req.integrationId);
        } catch {
          // Signal delivery failure is non-fatal — the proxy continues
          // to re-inject credentials on subsequent requests.
          skipped.push(req.integrationId);
        }
      }
      return { sent, skipped };
    },
    async shutdown() {
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          await Promise.allSettled(supervised.map((s) => s.process.stop()));
        })();
      }
      await shutdownPromise;
    },
  };

  return orchestrator;
}

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

/** Raised when an integration cannot complete its first spawn. */
export class SpawnFailureError extends Error {
  override readonly name = "SpawnFailureError";
  readonly integrationId: string;
  readonly namespace: string;
  readonly lastExit?: unknown;
  constructor(integrationId: string, namespace: string, lastExit?: unknown) {
    super(
      `Integration '${integrationId}' (namespace '${namespace}') failed to spawn after exhausting the restart schedule`,
    );
    this.integrationId = integrationId;
    this.namespace = namespace;
    if (lastExit !== undefined) this.lastExit = lastExit;
  }
}

// ─────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────

function noopEvent(_event: IntegrationOrchestratorEvent): void {}
