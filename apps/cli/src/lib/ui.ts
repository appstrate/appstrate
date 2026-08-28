// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal UI helpers — thin wrappers around `@clack/prompts` + a
 * single error formatter. Intended to keep command files focused on
 * flow rather than on prompt/spinner bookkeeping.
 */

import * as clack from "@clack/prompts";
import { DEFAULT_IO, type CommandIO } from "./io.ts";
import { DeviceFlowError } from "./device-flow.ts";
import { ApiError, AuthError } from "./api.ts";
import { InsecureInstanceError } from "./instance-url.ts";
import { formatErrorChain } from "@appstrate/core/errors";

/** What every prompt in this CLI says when the user Ctrl-Cs out of it. */
const CANCELLED = "Cancelled.";

/**
 * Exit code for a user-declined action. `130` is the shell's `128 + SIGINT`
 * convention, which `lib/shutdown.ts` and the lifecycle commands already use —
 * one value here means `if appstrate …; then` wrappers see the same code
 * whichever layer the cancel came from. Exported for the two commands that
 * decline on an explicit "no" rather than on Ctrl-C (`uninstall --purge`,
 * the installer's tier/backend picks).
 */
export const EXIT_CANCELLED = 130;

/**
 * Adapt a `CommandIO` into the stream clack renders to.
 *
 * clack accepts an `output` sink on every helper, so this is the seam that
 * lets a command's framing (`intro`, `outro`, the spinners) land in a
 * caller-owned buffer instead of the process-global stdout — the coupling
 * issue #1180 is about. Only the *bytes* are redirected: everything else is
 * inherited from the real stream, because clack asks its output for more
 * than `write`. `spinner()` reads `output.columns` to wrap frames (a bare
 * four-member sink has none, and clack would silently fall back to 80
 * columns, rewrapping every spinner line on a wider terminal) and hands the
 * stream to `node:readline`, which expects a stream. Prototyping off
 * `process.stdout` keeps the geometry, the `isTTY` flags and the readline
 * interop exactly as they are today, so the default path stays
 * byte-for-byte what it renders now.
 *
 * The trailing arguments cover `write(chunk, cb)` / `write(chunk, enc, cb)`:
 * readline passes a continuation there and stalls its cursor bookkeeping if
 * nobody calls it.
 */
function clackOutput(io: CommandIO): typeof process.stdout {
  return Object.create(process.stdout, {
    write: {
      value(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
        io.stdout.write(chunk);
        const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
        done?.();
        return true;
      },
    },
  }) as typeof process.stdout;
}

export function intro(title: string, io: CommandIO = DEFAULT_IO): void {
  clack.intro(title, { output: clackOutput(io) });
}

export function outro(message: string, io: CommandIO = DEFAULT_IO): void {
  clack.outro(message, { output: clackOutput(io) });
}

/**
 * Framed multi-line block (`clack.note`) — the CLI's report renderer:
 * `doctor`'s installation table, `runner`'s preflight / diagnostics /
 * post-install config, the installer's summaries.
 *
 * Same seam as `intro` / `outro`: the frame lands in the caller's sink when
 * one is injected, and on the real stdout otherwise.
 */
export function note(message: string, title?: string, io: CommandIO = DEFAULT_IO): void {
  clack.note(message, title, { output: clackOutput(io) });
}

/**
 * Single-line advisory lines (`clack.log.info` / `clack.log.warn`).
 *
 * Distinct from `note`: no frame, one line, and `logWarn` carries clack's
 * warning glyph. Used for in-flight remarks the user should notice but that
 * do not end the command (a missing `.env`, a preserved token, a skipped
 * upgrade step).
 */
export function logInfo(message: string, io: CommandIO = DEFAULT_IO): void {
  clack.log.info(message, { output: clackOutput(io) });
}

export function logWarn(message: string, io: CommandIO = DEFAULT_IO): void {
  clack.log.warn(message, { output: clackOutput(io) });
}

/**
 * The terminal-error banner WITHOUT the exit.
 *
 * `exitWithError` is what almost every failure wants: render, then stop. The
 * exception is a command that *reports* a failure rather than aborting on one
 * — `appstrate runner doctor` prints its diagnostics, banners the verdict and
 * sets `process.exitCode`, so the whole report stays on screen and a wrapper
 * script can still branch on the code.
 *
 * Routed through `io.cancel` (production: `clack.cancel`) for the same reason
 * `exitWithError` is: one renderer, one channel, and a test sink sees the
 * message as plain text.
 */
export function cancel(message: string, io: CommandIO = DEFAULT_IO): void {
  io.cancel(message);
}

/**
 * Defensive fail-fast for prompts with no matching non-interactive
 * flag (Bun install confirm, "Start dev server?", upgrade confirm, the
 * login instance URL askText, etc.). Without this, `@clack/prompts`
 * reads a closed/missing stdin and either hangs or SIGKILLs with no
 * readable error — issue #184. Callers that do have a flag (resolveTier,
 * resolveDir) should guard earlier with a specific message naming it.
 */
/**
 * The three prompt wrappers below each take a trailing `io`, like every other
 * wrapper in this file. They did not, and the ESLint funnel message named them
 * anyway ("Only `ui.ts` hands clack an `output`") — so a command with an
 * injected sink still had its prompt bytes and its "Cancelled." go to the real
 * stdout. `requireTTY` gates on stdin, not stdout, so this was reachable in
 * production too: `appstrate login > login.log` from a terminal wrote clack's
 * cursor escapes into the file.
 */
function requireTTY(message: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Cannot prompt "${message}": stdin is not a TTY. ` +
        "Re-run from an interactive terminal, or pass the matching flag " +
        "so the command doesn't need to prompt (see `appstrate <command> --help`).",
    );
  }
}

export async function askText(
  message: string,
  initialValue?: string,
  io: CommandIO = DEFAULT_IO,
): Promise<string> {
  requireTTY(message);
  const value = await clack.text({ message, initialValue, output: clackOutput(io) });
  if (clack.isCancel(value)) {
    exitWithError(CANCELLED, io, EXIT_CANCELLED);
  }
  return value;
}

export async function confirm(
  message: string,
  initialValue = true,
  io: CommandIO = DEFAULT_IO,
): Promise<boolean> {
  requireTTY(message);
  const value = await clack.confirm({ message, initialValue, output: clackOutput(io) });
  if (clack.isCancel(value)) {
    exitWithError(CANCELLED, io, EXIT_CANCELLED);
  }
  return value;
}

interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * Single-select picker wrapping `@clack/prompts.select`. Same cancel
 * semantics as `askText` / `confirm` — Ctrl-C exits 130 with a clean
 * "Cancelled." message. `initialValue` highlights the currently-active
 * choice (e.g. the pinned org in `appstrate org switch`) so users don't
 * accidentally pick the same value they already had.
 *
 * Clack's own `Option<Value>` is a conditional type (primitive values
 * get an optional label, object values get a required one). We expose a
 * simpler `SelectOption<T>` that always requires a label, and bridge
 * through `as unknown` because clack's conditional generic confuses the
 * inferred intersection when Value extends object — our wrapper's stricter
 * label requirement is always compatible with whichever branch clack picks.
 */
export async function select<T>(
  message: string,
  options: SelectOption<T>[],
  initialValue?: T,
  io: CommandIO = DEFAULT_IO,
): Promise<T> {
  requireTTY(message);
  const value = await clack.select<T>({
    message,
    options: options as unknown as Parameters<typeof clack.select<T>>[0]["options"],
    initialValue,
    output: clackOutput(io),
  });
  if (clack.isCancel(value)) {
    exitWithError(CANCELLED, io, EXIT_CANCELLED);
  }
  return value as T;
}

/**
 * The subset of clack's `SpinnerResult` this CLI drives. Kept local (not
 * exported) so `verify:dead-code` has no unread public type to flag; the two
 * factories below are the only producers and `ReturnType<typeof spinner>`
 * names it for any caller that needs to.
 */
interface Spinner {
  start(msg: string): void;
  message(msg: string): void;
  stop(msg?: string): void;
}

/**
 * A spinner is a *repaint*, and a repaint needs a cursor.
 *
 * `@clack/prompts` does not check for one. Its frame-clear writes
 * `cursor.up` / `cursor.to(0)` / `erase.down()` unconditionally; the only
 * thing it gates is one extra newline, on `isCI = process.env.CI === "true"`.
 * So `appstrate install > install.log` on a developer's box — no `CI` set,
 * stdout a file — lands `ESC[1G ESC[J` between every frame in the log (plus a
 * leading `ESC[1A` per extra wrapped row, and the `ESC[?25l` / `ESC[?25h`
 * cursor hide/show around the pair).
 * The spinner also calls clack's `block()`, which puts a real TTY's stdin in
 * raw mode; there is nothing to put in raw mode when the command is being
 * piped.
 *
 * The gate is `process.stdout.isTTY`, the same predicate the run sink already
 * uses to decide whether ANSI colour is legible (`commands/run/sink.ts`), and
 * it is read per call rather than at import so a test can exercise either
 * branch in a child process. Redirected output gets the same information as
 * plain lines: the start label when the work begins, the resolved stop label
 * when it ends.
 */
function plainSpinner(io: CommandIO): Spinner {
  let last = "";
  return {
    start(msg) {
      last = msg;
      io.stdout.write(`${msg}\n`);
    },
    // Progress ticks are deliberately dropped, not written: they exist to
    // overwrite the previous frame, and a download that ticks per chunk would
    // otherwise put thousands of near-identical lines in the log. The latest
    // one is retained so a bare `stop()` still names what finished.
    message(msg) {
      last = msg;
    },
    stop(msg) {
      io.stdout.write(`${msg ?? last}\n`);
    },
  };
}

/**
 * A spinner whose `start` / `stop` the caller drives itself.
 *
 * Prefer `withSpinner` — a caller that owns the pair owns the obligation to
 * stop it on **every** path, and the frames come from a `setInterval` nothing
 * else clears. Reach for this only when the start is conditional (the
 * self-update download starts on the first byte-tick), and stop it in a
 * `finally`.
 */
export function spinner(io: CommandIO = DEFAULT_IO): Spinner {
  if (!process.stdout.isTTY) return plainSpinner(io);
  return clack.spinner({ output: clackOutput(io) });
}

/**
 * Run `fn` with a started spinner, stopping it on **every** exit path.
 *
 * A clack spinner paints from a `setInterval` that only `stop()` clears, so a
 * body that throws past it leaves the frames painting for the rest of the
 * process. In the shipped CLI that is invisible — the error unwinds to
 * `exitWithError` and the process exits — but `bun test` runs the whole repo
 * in one process, where the leak outlives its test: `runner.test.ts` exercised
 * exactly such a path and its frames landed in another suite's capture
 * (issue #1180, `Received: "◒  Enabling systemd unit..."` on `whoami`). With
 * an injected `io` the frames go to that test's own sink instead — quieter,
 * but an unbounded buffer growing every 80ms for the rest of the run.
 *
 * `stopLabel` may be a callback when the success line quotes the result (the
 * dev server's pid). `errorLabel` defaults to `startLabel`: the frame closes
 * on what it was doing, and the thrown error is the report. Pass it when the
 * failure has a name of its own ("Docker not found").
 *
 * Off a TTY there are no frames at all — `spinner()` degrades to two plain
 * lines (start, then the resolved stop/error label), so a redirected run keeps
 * the same narrative without the cursor escapes.
 */
export async function withSpinner<T>(
  startLabel: string,
  fn: (spin: { message(msg: string): void }) => Promise<T>,
  stopLabel: string | ((value: T) => string),
  opts: { io?: CommandIO; errorLabel?: string } = {},
): Promise<T> {
  const spin = spinner(opts.io ?? DEFAULT_IO);
  spin.start(startLabel);
  let value: T;
  try {
    value = await fn(spin);
  } catch (err) {
    spin.stop(opts.errorLabel ?? startLabel);
    throw err;
  }
  spin.stop(typeof stopLabel === "function" ? stopLabel(value) : stopLabel);
  return value;
}

/**
 * Render an error with a user-actionable message. Used by the top-level
 * error handler in `cli.ts` — commands shouldn't catch expected errors,
 * they should let them bubble up here so the output stays consistent.
 */
export function formatError(err: unknown): string {
  if (err instanceof DeviceFlowError) {
    const canonical: Record<string, string> = {
      access_denied:
        "The request was refused. If this was unexpected, check that the CLI is allowed for this account.",
      expired_token:
        "The code expired before you approved it. Run the command again to get a new one.",
      invalid_client:
        "This CLI is not registered on the target instance. The platform may be running an incompatible version.",
      invalid_grant: "The authorization server rejected the device code. Run the command again.",
      invalid_request: "The authorization request was malformed.",
    };
    const base = canonical[err.code] ?? err.message;
    return `${base} (${err.code})`;
  }
  if (err instanceof InsecureInstanceError) return err.message;
  if (err instanceof AuthError) return err.message;
  if (err instanceof ApiError) return `API error (${err.status}): ${err.message}`;
  // Errors with a `hint` field (PackageSpecError, BundleFetchError, …)
  // render `<message> — <hint>` so the user sees the action item next to
  // the error. Avoids importing the error classes here just for instanceof.
  if (
    err instanceof Error &&
    typeof (err as Error & { hint?: unknown }).hint === "string" &&
    (err as Error & { hint: string }).hint.length > 0
  ) {
    return `${err.message} — ${(err as Error & { hint: string }).hint}`;
  }
  // The catch-all, and the one branch that renders whatever the CLI failed on
  // verbatim. `formatErrorChain` appends each `cause` — without it a wrapper's
  // message ("Failed to read the run snapshot") was the whole output and the
  // reason (ENOENT, a bad JSON offset) was discarded. Only Bun's UNCAUGHT
  // printer walked the chain, and reaching this function means the error was
  // caught. Identical to `err.message` when there is no cause.
  return formatErrorChain(err);
}

/**
 * Render `err` and stop the process. `io` defaults to `DEFAULT_IO`, whose
 * `cancel` is `clack.cancel` — so the production rendering is byte-for-byte
 * what it has always been, on the same stream. Tests inject a sink instead of
 * swapping the global streams (issue #1180).
 */
export function exitWithError(err: unknown, io: CommandIO = DEFAULT_IO, code = 1): never {
  io.cancel(formatError(err));
  io.exit(code);
}

/**
 * Format an 8-character user code with a mid-string dash for
 * readability — `ABCDEFGH` → `ABCD-EFGH`. Display only; BA's plugin
 * strips dashes before lookup.
 */
export function formatUserCode(raw: string): string {
  const clean = raw.replace(/-/g, "");
  if (clean.length !== 8) return raw;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}
