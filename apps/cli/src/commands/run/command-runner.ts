// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run @scope/agent -- <command>`: the CLI is the runner of a remote
 * run of the agent and runs the command under it; no agent executes. It holds
 * the run (first event, heartbeat, finalize) for as long as the command lives.
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

/** Wire literal of `X-Appstrate-Runner-Kind`: the platform's `isCommandRun` keys on it. */
const COMMAND_RUNNER_KIND = "command";

/** SIGKILL grace; with the finalize timeout alongside, under the shutdown coordinator's 10 s. */
const STOP_GRACE_MS = 3_000;

/**
 * A terminal's Ctrl-C signals the whole process group: the command may be seen gone before
 * this process's handler has run. A non-zero exit waits this long before it reads as `failed`.
 */
const INTERRUPT_SETTLE_MS = 100;

const EXIT_COMMAND_NOT_EXECUTABLE = 126;
const EXIT_COMMAND_NOT_FOUND = 127;

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };

interface CommandRunOptions {
  /** As written after `--`. Never empty. */
  command: readonly string[];
  packageId: string;
  spec: string | undefined;
  context: ReportContext;
  input: Record<string, unknown>;
  ttlSeconds?: number | undefined;
  connectionOverrides?: ConnectionOverrides | undefined;
  env?: Record<string, string>;

  // ─── Dependency injection (testing) ──────────────────────────────────
  writeStderr?: (chunk: string) => void;
  spawn?: typeof spawnCommand;
  stopGraceMs?: number;
  heartbeatIntervalMs?: number;
}

interface CommandRunShutdown {
  signal: AbortSignal;
  onShutdown(hook: () => Promise<void>): () => void;
}

interface CommandOutcome {
  exitCode: number;
  /** Null for a success; otherwise the reason the run is `failed`. */
  failure: string | null;
}

type Child = Pick<ReturnType<typeof Bun.spawn>, "exited" | "exitCode" | "signalCode" | "kill">;

function spawnCommand(command: readonly string[], env: Record<string, string | undefined>): Child {
  return Bun.spawn([...command], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
}

/** Rejects when the instance refuses the registration: the command is then never spawned. */
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

  // The command line is left out: its arguments may carry secrets a CI log would keep.
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
  // The instance answered that the run's sink is closed: nothing more can be reported.
  let closedOnInstance = false;
  let outcome: CommandOutcome = {
    exitCode: 1,
    failure: "Runner exited before the command completed (CLI error).",
  };

  // One idempotent close, shared by the shutdown coordinator and the `finally`
  // below. The run is `cancelled` iff a shutdown is in flight when it runs.
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> =>
    (closing ??= (async (): Promise<void> => {
      heartbeat?.stop();
      const cancelled = shutdown.signal.aborted;
      // Caught at creation: on a shutdown it is awaited only after the finalize.
      const stopped = child
        ? stopChild(child, opts.stopGraceMs ?? STOP_GRACE_MS).catch(warn("stopping the command"))
        : null;
      // A cancelled run is finalized at once, cutting the command's access while
      // it is being stopped; otherwise the command's exit is the status.
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
      session.httpSink.abort(new Error("run ended"));
      await stopped;
    })());

  const unregister = shutdown.onShutdown(close);
  try {
    // First event: flips the run `pending` → `running` and ends its boot deadline.
    // Sent before the spawn so a long silent command is not failed by it.
    const refusal = await emitRuntimeReady(session.httpSink, session.runId, {
      bundleLoaded: false,
      extensions: 0,
      bootDurationMs: performance.now(),
    }).then(
      () => null,
      (err: unknown) => ({ cause: getErrorMessage(err) }),
    );

    if (shutdown.signal.aborted) {
      // A shutdown that arrived meanwhile has already closed the run.
    } else if (refusal) {
      // What refuses the first event (bad signature, clock skew) refuses every
      // later signed call: the run is already lost, so the command is not started.
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

/** The failure as the platform is told it: a kind, never the error's text, which names a path. */
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
 * SIGKILL the command if this process exits while it is alive (a second Ctrl-C,
 * a crash): `exit` is the one hook that runs whatever the cause, synchronously.
 */
function killOnProcessExit(child: Child): () => void {
  const kill = (): void => killQuietly(child);
  process.on("exit", kill);
  return () => {
    process.off("exit", kill);
  };
}

function killQuietly(child: Child): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Gone already, or not this user's to signal; nothing catches a throw from a timer or `exit`.
  }
}

async function commandOutcome(child: Child, shutdown: AbortSignal): Promise<CommandOutcome> {
  await child.exited;
  const { exitCode, signalCode } = child;
  if (exitCode === 0) return { exitCode: 0, failure: null };
  await sleepUnlessAborted(INTERRUPT_SETTLE_MS, shutdown);
  if (signalCode !== null) {
    return {
      exitCode: 128 + (osConstants.signals[signalCode] ?? 0),
      failure: `Command terminated by ${signalCode}`,
    };
  }
  return { exitCode: exitCode ?? 1, failure: `Command exited with code ${exitCode}` };
}

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

/** SIGTERM, then SIGKILL after `graceMs`. Rejects when the command cannot be signalled. */
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
