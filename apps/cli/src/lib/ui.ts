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
 * Defensive fail-fast for prompts with no matching non-interactive
 * flag (Bun install confirm, "Start dev server?", upgrade confirm, the
 * login instance URL askText, etc.). Without this, `@clack/prompts`
 * reads a closed/missing stdin and either hangs or SIGKILLs with no
 * readable error — issue #184. Callers that do have a flag (resolveTier,
 * resolveDir) should guard earlier with a specific message naming it.
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

export async function askText(message: string, initialValue?: string): Promise<string> {
  requireTTY(message);
  const value = await clack.text({ message, initialValue });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}

export async function confirm(message: string, initialValue = true): Promise<boolean> {
  requireTTY(message);
  const value = await clack.confirm({ message, initialValue });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
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
): Promise<T> {
  requireTTY(message);
  const value = await clack.select<T>({
    message,
    options: options as unknown as Parameters<typeof clack.select<T>>[0]["options"],
    initialValue,
  });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value as T;
}

export function spinner(io: CommandIO = DEFAULT_IO): {
  start(msg: string): void;
  stop(msg?: string): void;
} {
  return clack.spinner({ output: clackOutput(io) });
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
  if (err instanceof Error) return err.message;
  return String(err);
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
