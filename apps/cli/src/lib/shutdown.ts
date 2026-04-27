// SPDX-License-Identifier: Apache-2.0

/**
 * Central shutdown coordinator for the CLI process.
 *
 * Replaces the historical pattern where each command (and the CLI
 * bootstrap itself) registered its own `process.on("SIGINT", …)` with
 * a synchronous `process.exit()` inside. That pattern was order-fragile:
 * the bootstrap handler always fired before a subcommand's, exited
 * synchronously, and prevented the subcommand's cooperative cancel
 * (AbortController flip + safety-net finalize POST + workspace teardown)
 * from running. The result was platform-side runs sitting open for
 * ~60 s until the watchdog swept them.
 *
 * Design contract:
 * - One `AbortSignal` (`shutdownSignal`) shared across the process.
 *   Subcommands pass it to async work (e.g. `runner.run({ signal })`)
 *   and the work unwinds when a signal arrives.
 * - Cleanup hooks registered via `onShutdown(fn)` are awaited (with
 *   `Promise.allSettled`) before the process exits. A bounded timeout
 *   (`SHUTDOWN_TIMEOUT_MS`) guarantees the CLI never hangs longer than
 *   the user expects after Ctrl-C, even if a hook is wedged.
 * - A second signal while shutdown is in flight short-circuits to
 *   `process.exit` immediately — the standard "Ctrl-C twice to force"
 *   UX every CLI user already knows.
 *
 * Crash paths (`uncaughtException`, `unhandledRejection`) intentionally
 * do NOT route through this coordinator — they go through `exitWithError`
 * for fast, sync exit. Hooks that must always run regardless of exit
 * cause should also register with `process.on("exit", …)`.
 */

export type ShutdownHook = () => Promise<void> | void;

type ShutdownOptions = {
  /** Injected for tests so they can assert exit codes without killing the test runner. */
  exit?: (code: number) => void;
  /** Override the default 10s cleanup ceiling. Tests use a small value to keep the suite fast. */
  timeoutMs?: number;
};

/**
 * Maps each handled signal to its conventional POSIX exit code
 * (128 + signal number). These are the codes Bash and most CLIs return
 * when a process is terminated by the corresponding signal — preserving
 * them keeps shell pipelines (`cmd && next`) and CI behaviour intact.
 */
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} as const satisfies Partial<Record<NodeJS.Signals, number>>;

const HANDLED_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as Array<keyof typeof SIGNAL_EXIT_CODES>;

/**
 * Hard ceiling on the time a shutdown waits for hooks to settle before
 * exiting anyway. 10 s is the upper end of the industry-standard
 * graceful-shutdown window (Kubernetes pre-stop hook default is 30 s,
 * Node graceful-shutdown guides converge on 5–10 s). We sit at 10 s
 * because the CLI's own safety-net finalize is internally bounded at 5 s
 * and we want a small headroom for filesystem teardown after it.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

export class ShutdownCoordinator {
  // Set instead of array: cheap O(1) `delete` for `unregister`, and the
  // JS spec guarantees insertion-order iteration so registration order
  // is preserved (matters for hooks that observe each other's effects,
  // e.g. heartbeat-stop before finalize).
  private readonly hooks = new Set<ShutdownHook>();
  private readonly controller = new AbortController();
  private readonly exit: (code: number) => void;
  private readonly timeoutMs: number;
  /** Tracks the in-flight shutdown so a second signal can short-circuit. */
  private inFlight: Promise<void> | null = null;

  constructor(options: ShutdownOptions = {}) {
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Returns an unregister function — symmetric with EventTarget's `addEventListener` API. */
  onShutdown(hook: ShutdownHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  /**
   * Trigger shutdown. Idempotent on the abort/cleanup path; the second
   * call (typically a second Ctrl-C) bypasses cleanup and exits.
   */
  async trigger(reason: string, exitCode: number): Promise<void> {
    if (this.inFlight !== null) {
      this.exit(exitCode);
      return;
    }
    this.controller.abort(new Error(`shutdown (${reason})`));
    this.inFlight = this.runHooks();
    await this.inFlight;
    this.exit(exitCode);
  }

  private async runHooks(): Promise<void> {
    // `Promise.resolve().then(fn)` defends against a hook that throws
    // synchronously — it would otherwise short-circuit `Array.prototype.map`
    // before later hooks even started.
    const settled = Promise.allSettled([...this.hooks].map((hook) => Promise.resolve().then(hook)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.timeoutMs);
      // Don't let the timer itself keep the loop alive once everything else has settled.
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([settled.then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Process-wide singleton. The CLI entrypoint installs the signal
 * listeners; subcommands import `shutdownSignal` and `onShutdown`
 * directly without caring about the underlying instance.
 */
export const coordinator = new ShutdownCoordinator();

export const shutdownSignal: AbortSignal = coordinator.signal;
export const onShutdown = (hook: ShutdownHook): (() => void) => coordinator.onShutdown(hook);

let signalHandlersInstalled = false;

/**
 * Wires the singleton coordinator to POSIX signals. Idempotent —
 * calling more than once is safe (and a no-op). Tests that exercise
 * the coordinator directly skip this and use a fresh
 * `ShutdownCoordinator` to keep the test process clean.
 */
export function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of HANDLED_SIGNALS) {
    process.on(signal, () => {
      // Fire-and-forget: signal handlers can't be async themselves, but
      // `trigger` owns the exit so nothing meaningful happens after.
      void coordinator.trigger(signal, SIGNAL_EXIT_CODES[signal]);
    });
  }
}
