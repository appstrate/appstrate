// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run @scope/agent -- <command> [args…]` — the CLI is the runner of
 * an ordinary remote run of the agent, and what it runs is the command: no
 * agent executes, no model is called.
 *
 * The run exists for what it binds. The command reads its id from
 * `APPSTRATE_RUN_ID` and names it on its credential-proxy calls
 * (`X-Run-Id`), which reach the connections the run bound.
 *
 * The CLI holds the run for as long as the command lives, because the
 * platform fails a remote run that emits no event before its boot deadline or
 * whose heartbeat stops, and only the run secret signs events and the
 * finalize: register → first event → heartbeat → spawn → finalize with the
 * command's outcome.
 *
 * stdout belongs to the command: everything this module prints goes to stderr.
 */

import { constants as osConstants } from "node:os";
import { emitRuntimeReady, type SinkHeartbeatHandle } from "@appstrate/runner-pi";
import { emptyRunResult, type TerminalRunResult } from "@appstrate/afps-runtime/runner";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ConnectionOverrides } from "@appstrate/core/integration";
import { announceLaunch } from "./launch-warnings.ts";
import { registryVersion } from "./package-spec.ts";
import {
  finalizeWithin,
  hostSnapshot,
  SAFETY_NET_FINALIZE_TIMEOUT_MS,
  startReportHeartbeat,
  startReportSession,
  type ReportContext,
} from "./report.ts";

/**
 * `X-Appstrate-Runner-Kind` of a runner that executes a command. A wire
 * literal the platform reads (`COMMAND_RUNNER_KIND`, `apps/api`): a remote run
 * of this kind may finish `success` with zero tokens, where any other run is
 * failed as "LLM never reached".
 */
const COMMAND_RUNNER_KIND = "command";

/**
 * How long a shutdown waits for the signalled command before SIGKILL. With the
 * finalize budget (`SAFETY_NET_FINALIZE_TIMEOUT_MS`) it stays under the
 * shutdown coordinator's 10 s ceiling.
 */
const STOP_GRACE_MS = 3_000;

/**
 * Exit codes of a command that could not be started, as a shell reports them:
 * found but not executable, and not found — which also stands for any other
 * spawn failure.
 */
const EXIT_COMMAND_NOT_EXECUTABLE = 126;
const EXIT_COMMAND_NOT_FOUND = 127;

interface CommandRunOptions {
  /** The command and its arguments, as written after `--`. Never empty. */
  command: readonly string[];
  /** `@scope/name` of the agent the run is registered under. */
  packageId: string;
  /** Version spec written after the id's `@`, if any. */
  spec: string | undefined;
  /** Instance and credentials the run is registered with. */
  context: ReportContext;
  /** Run input — the server validates it against the agent's input schema. */
  input: Record<string, unknown>;
  /** Requested sink TTL in seconds. Clamped by the server. */
  ttlSeconds?: number | undefined;
  /** `--connection` picks, sent as the registration's `connection_overrides`. */
  connectionOverrides?: ConnectionOverrides | undefined;

  // ─── Dependency injection (testing) ──────────────────────────────────
  /** Defaults to `process.stderr`. */
  writeStderr?: (chunk: string) => void;
  /** Working directory of the command. Defaults to the CLI's own. */
  cwd?: string;
  /** Overrides {@link STOP_GRACE_MS}. */
  stopGraceMs?: number;
}

/** The process's shutdown coordinator, as far as a command run uses it. */
interface CommandRunShutdown {
  signal: AbortSignal;
  onShutdown(hook: () => Promise<void>): () => void;
}

/** How the command ended: the CLI's exit code, and what the run is finalized with. */
interface CommandOutcome {
  exitCode: number;
  /** Null for a success; otherwise the reason the run is `failed`. */
  failure: string | null;
}

type Child = ReturnType<typeof Bun.spawn>;

/**
 * Register the run, hold it while the command runs, finalize it with the
 * command's outcome. Resolves with the exit code the CLI reports: the
 * command's own, 128 + n when signal n terminated it, and when it could not
 * be started 126 (found, not executable) or 127 (not found, or any other spawn
 * failure). Rejects when the instance refuses the registration — the command
 * is then never spawned.
 */
export async function runCommandAsRunner(
  opts: CommandRunOptions,
  shutdown: CommandRunShutdown,
): Promise<number> {
  const writeStderr = opts.writeStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const warn =
    (what: string) =>
    (err: unknown): void => {
      writeStderr(`warn: ${what} failed: ${getErrorMessage(err)}\n`);
    };

  const { stage, spec } = registryVersion(opts.spec);
  const session = await startReportSession(
    { kind: "registry", packageId: opts.packageId, stage, ...(spec ? { spec } : {}) },
    opts.context,
    {
      mode: "true",
      fallback: "abort",
      ttlSeconds: opts.ttlSeconds,
      connectionOverrides: opts.connectionOverrides,
      input: opts.input,
      runnerKind: COMMAND_RUNNER_KIND,
    },
    hostSnapshot(),
  );
  const registeredAt = performance.now();

  // The human form of the announcement writes stderr only. The command line is
  // left out of it: its arguments may carry secrets a CI log would keep.
  announceLaunch({
    type: "appstrate.report.started",
    json: false,
    bundleLabel: `${opts.packageId}${opts.spec ? `@${opts.spec}` : ""}`,
    instance: opts.context.instance,
    run: session,
    writeStdout: () => {},
    writeStderr,
  });

  let heartbeat: SinkHeartbeatHandle | null = null;
  let child: Child | null = null;
  let outcome: CommandOutcome = {
    exitCode: 1,
    failure: "Runner exited before the command completed (CLI error).",
  };

  // One idempotent close, shared by the shutdown coordinator (on a signal) and
  // the `finally` below (on completion): both await the same work. It is the
  // single place that decides the run's status — `cancelled` iff a shutdown is
  // in flight when it runs, the command's own outcome otherwise.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> =>
    (closing ??= (async (): Promise<void> => {
      heartbeat?.stop();
      const cancelled = shutdown.signal.aborted;
      // Still alive only on a shutdown, or on an error after the spawn.
      if (child) await stopChild(child, opts.stopGraceMs ?? STOP_GRACE_MS);
      const result: TerminalRunResult = {
        ...emptyRunResult(),
        ...terminalFields(cancelled, outcome),
        durationMs: Math.round(performance.now() - registeredAt),
      };
      await finalizeWithin(
        session.httpSink,
        session.httpSink.finalize(result),
        SAFETY_NET_FINALIZE_TIMEOUT_MS,
      ).catch(warn("finalize"));
      // The run is over: no report request may outlive it.
      session.httpSink.abort(new Error("run ended"));
    })());

  const unregister = shutdown.onShutdown(close);
  try {
    // The run's first event: the platform flips it `pending` → `running` on
    // it, and stops counting its boot deadline. Sent before the command
    // starts so a command that outlives that deadline in silence is not failed.
    await emitRuntimeReady(session.httpSink, session.runId, {
      bundleLoaded: false,
      extensions: 0,
      bootDurationMs: performance.now(),
    }).catch(warn("runtime ready event"));

    // A shutdown that arrived meanwhile has already closed the run: nothing
    // more is started.
    if (!shutdown.signal.aborted) {
      heartbeat = startReportHeartbeat(session, warn("heartbeat"));
      try {
        child = Bun.spawn([...opts.command], {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: { ...process.env, APPSTRATE_RUN_ID: session.runId },
        });
      } catch (err) {
        const failure = `Command could not be started: ${getErrorMessage(err)}`;
        writeStderr(`error: ${failure}\n`);
        const notExecutable = err instanceof Error && "code" in err && err.code === "EACCES";
        outcome = {
          exitCode: notExecutable ? EXIT_COMMAND_NOT_EXECUTABLE : EXIT_COMMAND_NOT_FOUND,
          failure,
        };
      }
      if (child) outcome = await commandOutcome(child);
    }
  } finally {
    // Unregistered only once closed: a signal arriving during the close makes
    // the coordinator wait for this same finalize instead of exiting over it.
    await close().catch(warn("cleanup"));
    unregister();
  }
  return outcome.exitCode;
}

/** Wait for `child` and read how it ended. */
async function commandOutcome(child: Child): Promise<CommandOutcome> {
  await child.exited;
  const { exitCode, signalCode } = child;
  if (signalCode !== null) {
    // A terminal's Ctrl-C signals the whole foreground process group, so the
    // command can be seen dead before this process's own handler has run. One
    // turn of the event loop lets that handler flip the shutdown signal, and
    // the run reads `cancelled` rather than `failed`.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      exitCode: 128 + (osConstants.signals[signalCode] ?? 0),
      failure: `Command terminated by ${signalCode}`,
    };
  }
  if (exitCode === 0) return { exitCode: 0, failure: null };
  return { exitCode: exitCode ?? 1, failure: `Command exited with code ${exitCode}` };
}

/** The outcome half of the finalize body. */
function terminalFields(
  cancelled: boolean,
  outcome: CommandOutcome,
): Pick<TerminalRunResult, "status" | "error" | "usage"> {
  if (cancelled) {
    return {
      status: "cancelled",
      error: { message: "Command cancelled (CLI received a signal)." },
    };
  }
  if (outcome.failure !== null) return { status: "failed", error: { message: outcome.failure } };
  // A success must state its usage, and a command's is truthfully zero.
  return { status: "success", usage: { input_tokens: 0, output_tokens: 0 } };
}

/** Ask `child` to terminate and SIGKILL it once `graceMs` has passed. Resolves when it is gone. */
async function stopChild(child: Child, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
