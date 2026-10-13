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
import { sleepUnlessAborted } from "../../lib/abortable-sleep.ts";
import { announceLaunch } from "./launch-warnings.ts";
import { registryVersion, runTargetLabel } from "./package-spec.ts";
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
 * of this kind may finish `success` with zero tokens and no output, where any
 * other run is failed as "LLM never reached" or for the output it owes.
 */
const COMMAND_RUNNER_KIND = "command";

/**
 * How long a shutdown waits for the signalled command before SIGKILL. The
 * finalize goes out meanwhile, within `SAFETY_NET_FINALIZE_TIMEOUT_MS`: the
 * longer of the two stays under the shutdown coordinator's 10 s ceiling.
 */
const STOP_GRACE_MS = 3_000;

/**
 * How long a command that did not exit 0 waits for the CLI's own shutdown
 * before its run is read as `failed`. A terminal's Ctrl-C signals the whole
 * foreground process group, and the command may answer it by dying of it or by
 * exiting with a code of its own (a shell's 130, a handler's `exit(1)`): either
 * way it can be seen gone before this process's handler has run, which is a
 * matter of milliseconds.
 */
const INTERRUPT_SETTLE_MS = 100;

/**
 * Exit codes of a command that could not be started, as a shell reports them:
 * found but not executable, and not found — which also stands for any other
 * spawn failure.
 */
const EXIT_COMMAND_NOT_EXECUTABLE = 126;
const EXIT_COMMAND_NOT_FOUND = 127;

/** A command calls no model: its usage is truthfully zero, whatever its outcome. */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };

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
  /**
   * Added to the command's environment, over the CLI's own and under
   * `APPSTRATE_RUN_ID`: what lets an `appstrate` the command runs reach the
   * instance and identity the run is registered with.
   */
  env?: Record<string, string>;

  // ─── Dependency injection (testing) ──────────────────────────────────
  /** Defaults to `process.stderr`. */
  writeStderr?: (chunk: string) => void;
  /** Starts the command. Defaults to {@link spawnCommand}. */
  spawn?: typeof spawnCommand;
  /** Overrides {@link STOP_GRACE_MS}. */
  stopGraceMs?: number;
  /** Overrides the heartbeat helper's interval. */
  heartbeatIntervalMs?: number;
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

/** What the runner reads of the command's process. */
type Child = Pick<ReturnType<typeof Bun.spawn>, "exited" | "exitCode" | "signalCode" | "kill">;

/** The command as a child of this process: its stdio is the CLI's own. */
function spawnCommand(command: readonly string[], env: Record<string, string | undefined>): Child {
  return Bun.spawn([...command], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
}

/**
 * Register the run, hold it while the command runs, finalize it with the
 * command's outcome. Resolves with the exit code the CLI reports: the
 * command's own, 128 + n when signal n terminated it, and when it could not
 * be started 126 (found, not executable) or 127 (not found, or any other spawn
 * failure); 1 when the run's first event is refused, the command then never
 * started. Rejects when the instance refuses the registration — the command
 * is then never spawned either.
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
    bundleLabel: `a command under ${runTargetLabel(opts.packageId, opts.spec)}`,
    instance: opts.context.instance,
    run: session,
    writeStdout: () => {},
    writeStderr,
  });

  let heartbeat: SinkHeartbeatHandle | null = null;
  let child: Child | null = null;
  // Set when the instance answers that the run's sink is closed (cancelled
  // through the API, failed by the watchdog, or past its TTL): nothing more
  // can be reported for it.
  let closedOnInstance = false;
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
      // Handled where it is created: the finalize is awaited before it on a
      // shutdown, and a command this user may not signal must not surface there.
      const stopped = child
        ? stopChild(child, opts.stopGraceMs ?? STOP_GRACE_MS).catch(warn("stopping the command"))
        : null;
      // On a shutdown the run is `cancelled` whatever the command does next,
      // so it is closed at once — and the command's access with it — while the
      // command is being stopped. Otherwise the command's exit is the status.
      if (!cancelled) await stopped;
      if (!closedOnInstance) {
        const result: TerminalRunResult = {
          ...emptyRunResult(),
          ...terminalFields(cancelled, outcome),
          usage: ZERO_USAGE,
          durationMs: Math.round(performance.now() - registeredAt),
        };
        await finalizeWithin(
          session.httpSink,
          session.httpSink.finalize(result),
          SAFETY_NET_FINALIZE_TIMEOUT_MS,
        ).catch(warn("finalize"));
      }
      // The run is over: no report request may outlive it.
      session.httpSink.abort(new Error("run ended"));
      await stopped;
    })());

  const unregister = shutdown.onShutdown(close);
  try {
    // The run's first event: the platform flips it `pending` → `running` on
    // it, and stops counting its boot deadline. Sent before the command
    // starts so a command that outlives that deadline in silence is not failed.
    const refusal = await emitRuntimeReady(session.httpSink, session.runId, {
      bundleLoaded: false,
      extensions: 0,
      bootDurationMs: performance.now(),
    }).then(
      () => null,
      (err: unknown) => ({ cause: getErrorMessage(err) }),
    );

    if (shutdown.signal.aborted) {
      // A shutdown that arrived meanwhile has already closed the run: nothing
      // more is started.
    } else if (refusal) {
      // What refuses the first event (a signature the instance cannot verify,
      // a clock out of tolerance) refuses every later signed call, and the
      // platform fails the run at its boot deadline: the command would run
      // under a run that is already lost.
      const failure = `The run's first event could not be delivered: ${refusal.cause}`;
      writeStderr(`error: ${failure}\nerror: The command was not started.\n`);
      outcome = { exitCode: 1, failure };
    } else {
      heartbeat = startReportHeartbeat(session, warn("heartbeat"), {
        intervalMs: opts.heartbeatIntervalMs,
        onClosed: () => {
          closedOnInstance = true;
          writeStderr(
            `warn: run ${session.runId} is closed on the instance, which reports nothing more for it and stops serving the calls that name it. The command keeps running.\n`,
          );
        },
      });
      try {
        child = (opts.spawn ?? spawnCommand)(opts.command, {
          ...process.env,
          ...opts.env,
          APPSTRATE_RUN_ID: session.runId,
        });
      } catch (err) {
        // The full text names the command's path: it stays on this terminal.
        writeStderr(`error: Command could not be started: ${getErrorMessage(err)}\n`);
        outcome = spawnFailure(err);
      }
      if (child) {
        const disarm = killOnProcessExit(child);
        void child.exited.then(disarm);
        outcome = await commandOutcome(child, shutdown.signal);
      }
    }
  } finally {
    // Unregistered only once closed: a signal arriving during the close makes
    // the coordinator wait for this same finalize instead of exiting over it.
    await close().catch(warn("cleanup"));
    unregister();
  }
  return outcome.exitCode;
}

/**
 * Why the command could not be started, as the platform is told: the kind of
 * failure and never the spawn error's text, which names the command's path.
 */
function spawnFailure(err: unknown): CommandOutcome {
  const code = err instanceof Error && "code" in err ? err.code : null;
  if (code === "ENOENT") {
    return { exitCode: EXIT_COMMAND_NOT_FOUND, failure: "Command could not be started: not found" };
  }
  if (code === "EACCES" || code === "ENOEXEC") {
    return {
      exitCode: EXIT_COMMAND_NOT_EXECUTABLE,
      failure: "Command could not be started: not executable",
    };
  }
  return {
    exitCode: EXIT_COMMAND_NOT_FOUND,
    failure: `Command could not be started: spawn error${typeof code === "string" ? ` ${code}` : ""}`,
  };
}

/**
 * SIGKILL the command's own process if this process exits while it is alive —
 * a second Ctrl-C that cuts the shutdown short, a crash. The `exit` event is
 * the one hook that runs whatever the cause, and it is synchronous. Processes
 * the command started are not reached: they are the command's own to stop.
 * Returns the disarm, to call once the child has exited.
 */
function killOnProcessExit(child: Child): () => void {
  const kill = (): void => killQuietly(child);
  process.on("exit", kill);
  return () => {
    process.off("exit", kill);
  };
}

/** SIGKILL `child` from where nothing catches a throw (a timer, the `exit` event). */
function killQuietly(child: Child): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Not this user's to signal, or gone already: nothing more to do here.
  }
}

/** Wait for `child` and read how it ended. */
async function commandOutcome(child: Child, shutdown: AbortSignal): Promise<CommandOutcome> {
  await child.exited;
  const { exitCode, signalCode } = child;
  if (exitCode === 0) return { exitCode: 0, failure: null };
  // Any other ending may be the command's answer to a signal this process
  // received too: its own shutdown then makes the run `cancelled`, not `failed`.
  await sleepUnlessAborted(INTERRUPT_SETTLE_MS, shutdown);
  if (signalCode !== null) {
    return {
      exitCode: 128 + (osConstants.signals[signalCode] ?? 0),
      failure: `Command terminated by ${signalCode}`,
    };
  }
  return { exitCode: exitCode ?? 1, failure: `Command exited with code ${exitCode}` };
}

/** The outcome half of the finalize body. */
function terminalFields(
  cancelled: boolean,
  outcome: CommandOutcome,
): Pick<TerminalRunResult, "status" | "error"> {
  if (cancelled) {
    return {
      status: "cancelled",
      error: { message: "Command cancelled (CLI received a signal)." },
    };
  }
  if (outcome.failure !== null) return { status: "failed", error: { message: outcome.failure } };
  return { status: "success" };
}

/**
 * Ask the command's process to terminate and SIGKILL it once `graceMs` has
 * passed. Resolves when it is gone; rejects when it cannot be signalled.
 */
async function stopChild(child: Child, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => killQuietly(child), graceMs);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
