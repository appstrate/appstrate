// SPDX-License-Identifier: Apache-2.0

import { logger } from "../../lib/logger.ts";
import type { LoadedPackage } from "../../types/index.ts";
import { updateRun, appendRunLog } from "../state/runs.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { runPlatformContainer } from "./pi.ts";
import type { PlatformContainerResult } from "./pi.ts";
import type { RunOrchestrator } from "../orchestrator/index.ts";
import { trackRun, untrackRun } from "../run-tracker.ts";
import { emitEvent } from "../../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "../inline-run.ts";
import { synthesiseFinalize } from "../run-event-ingestion.ts";
import type { SinkCredentials } from "../../lib/mint-sink-credentials.ts";
import { runWithSpan } from "@appstrate/core/telemetry";
import {
  acquireBrowserSessionLease,
  releaseBrowserSessionLease,
  type BrowserSessionLease,
} from "../browser-connection-state.ts";

// --- Background run (decoupled from client) ---

export interface ExecuteAgentInBackgroundInput {
  runId: string;
  orgId: string;
  applicationId: string;
  agent: LoadedPackage;
  context: ExecutionContext;
  plan: AppstrateRunPlan;
  agentPackage?: Buffer | null;
  modelSource?: string | null;
  /** Sink credentials minted by `run-pipeline.ts` and persisted on the run row. */
  sinkCredentials: SinkCredentials;
  /**
   * Injectable orchestrator — production leaves this unset and the
   * global singleton drives Docker. Tests inject a fake orchestrator to
   * exercise the lifecycle without a real container runtime.
   */
  orchestrator?: RunOrchestrator;
  /**
   * Grace (ms) added to `plan.timeout` for the platform's safety-net
   * container watchdog. Production leaves this unset (the runner owns the
   * primary, boot-excluded budget; the platform default folds in cold-start).
   * Tests inject `0` to exercise the net at the budget itself.
   */
  timeoutBootGraceMs?: number;
}

/**
 * Drive a platform-origin container through its lifecycle. This function is
 * pure orchestration — no DB writes beyond the initial `running` flip + the
 * terminal synthesis when the container doesn't finalise itself.
 *
 * All event + state persistence happens inside the container (via
 * {@link HttpSink}) or inside {@link finalizeRun} (the convergence
 * point). The only state this function owns is the in-process abort
 * controller used to propagate user-triggered cancellation to the
 * Docker workload.
 *
 * The body runs inside the `appstrate.run.execute` span — parented from the
 * launching request's trace so the whole API→run→container path shares one
 * trace_id. The container's own outbound events are linked via the forwarded
 * traceparent (pi.ts). The span is a true no-op when observability is disabled.
 */
export async function executeAgentInBackground(
  input: ExecuteAgentInBackgroundInput,
): Promise<void> {
  await runWithSpan(
    "appstrate.run.execute",
    {
      traceparent: input.context.traceparent,
      attributes: {
        "appstrate.run.id": input.runId,
        "appstrate.org.id": input.orgId,
        "appstrate.application.id": input.applicationId,
        "appstrate.package.id": input.agent.id,
      },
    },
    () => executeAgentInBackgroundImpl(input),
  );
}

async function executeAgentInBackgroundImpl(input: ExecuteAgentInBackgroundInput): Promise<void> {
  const {
    runId,
    orgId,
    applicationId,
    agent,
    context,
    plan,
    agentPackage,
    modelSource,
    sinkCredentials,
  } = input;

  const scope = { orgId, applicationId };
  const startTime = Date.now();
  const controller = trackRun(runId);
  const { signal } = controller;
  const packageEphemeral = isInlineShadowPackageId(agent.id);
  const browserBindingVersions = new Map<string, number>();
  let browserBindingConflict = false;
  for (const spec of plan.integrations ?? []) {
    const binding = spec.browser?.providerBinding;
    if (!binding) continue;
    const existing = browserBindingVersions.get(binding.bindingId);
    if (existing !== undefined && existing !== binding.stateVersion) {
      browserBindingConflict = true;
      continue;
    }
    browserBindingVersions.set(binding.bindingId, binding.stateVersion);
  }
  const browserBindings = [...browserBindingVersions].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const browserLeases: BrowserSessionLease[] = [];

  try {
    if (browserBindingConflict) {
      throw new Error("BROWSER_STATE_CONFLICT: run resolved inconsistent browser bindings");
    }
    // Serialize provider-profile use before any browser workload starts. The
    // lease spans the complete run and carries a fencing token so a stale
    // cleanup cannot release a newer owner's takeover.
    for (const [bindingId, stateVersion] of browserBindings) {
      browserLeases.push(
        await acquireBrowserSessionLease({
          bindingId,
          ownerId: `run:${runId}`,
          ttlMs: Math.min(4 * 60 * 60_000, (plan.timeout + 300) * 1_000),
          expectedStateVersion: stateVersion,
        }),
      );
    }
    // Status flip — pending → running — is the ONE lifecycle transition
    // the platform still owns (the container can't authoritatively
    // announce itself running because it doesn't know when the server
    // actually accepted its first event). Everything terminal flows
    // through finalizeRun.
    await updateRun(scope, runId, { status: "running" });
    // Platform-owned latency contribution before the container takes over:
    // entry → running flip. The subsequent container-spawn cost is captured
    // by `recordContainerSpawn` inside `runPlatformContainer`.
    logger.info("run spawn timings", { runId, flipMs: Date.now() - startTime });
    // Second platform breadcrumb — the run is flipped to running and we are
    // about to provision the isolation boundary + spawn the sidecar/agent
    // containers (that work happens inside `runPlatformContainer`, below).
    // Streams live over the same run_logs pg_notify → SSE path. Best-effort:
    // a failed breadcrumb must never fail the run.
    void appendRunLog(
      scope,
      runId,
      "progress",
      "progress",
      "containers starting",
      { platform: true },
      "info",
    ).catch((err) => {
      logger.warn("failed to append platform progress log (containers starting)", {
        runId,
        error: getErrorMessage(err),
      });
    });
    void emitEvent("onRunStatusChange", {
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "started",
      packageEphemeral,
      ...(modelSource ? { modelSource } : {}),
    });

    const runPlan: AppstrateRunPlan = {
      ...plan,
      agentPackage: agentPackage ?? undefined,
    };

    let lifecycle: PlatformContainerResult;
    try {
      lifecycle = await runPlatformContainer({
        runId,
        context,
        plan: runPlan,
        sinkCredentials,
        signal,
        ...(input.orchestrator ? { orchestrator: input.orchestrator } : {}),
        ...(input.timeoutBootGraceMs !== undefined
          ? { timeoutBootGraceMs: input.timeoutBootGraceMs }
          : {}),
      });
    } catch (err) {
      // Orchestrator-level failure (Docker unreachable, image missing, ...)
      // before the container even exited. Cancel case is handled below in
      // the `finally` — we only synthesise a terminal failure here for
      // genuine infrastructure errors.
      if (signal.aborted) return;
      const message = getErrorMessage(err);
      logger.error("runPlatformContainer threw — synthesising failed terminal", {
        runId,
        error: message,
      });
      await synthesiseFinalize(runId, {
        status: "failed",
        error: { message, stack: err instanceof Error ? err.stack : undefined },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Container exited normally. If it finalised itself over HTTP, our
    // synthesis is a CAS no-op. If it didn't (crash, timeout, cancel),
    // we fill in the terminal state the platform observed.
    if (lifecycle.cancelled) {
      // Cancel route already routed the run through `synthesiseFinalize`,
      // which CAS'd the sink closed and ran `afterRun`. Nothing to do here.
      return;
    }

    if (lifecycle.timedOut) {
      await synthesiseFinalize(runId, {
        status: "timeout",
        error: { message: `Run timed out after ${plan.timeout}s` },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    if (lifecycle.exitCode !== 0) {
      await synthesiseFinalize(runId, {
        status: "failed",
        error: {
          message: `Agent container exited with code ${lifecycle.exitCode}`,
        },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Exit code 0 — the container ran to completion and should have
    // called finalize itself. Defensively synthesise success so a
    // container that forgot to finalise still reaches a terminal state;
    // the CAS makes this a no-op when the container did call finalize.
    await synthesiseFinalize(runId, {
      status: "success",
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Unhandled error in executeAgentInBackground", { runId, error: message });
    await synthesiseFinalize(runId, {
      status: "failed",
      error: { message, stack: err instanceof Error ? err.stack : undefined },
      durationMs: Date.now() - startTime,
    });
  } finally {
    for (const lease of browserLeases.reverse()) {
      await releaseBrowserSessionLease(lease).catch((error) => {
        logger.warn("browser session lease release failed", {
          runId,
          bindingId: lease.bindingId,
          error: getErrorMessage(error),
        });
      });
    }
    untrackRun(runId);
  }
}
