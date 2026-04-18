// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal UI helpers — thin wrappers around `@clack/prompts` + a
 * single error formatter. Intended to keep command files focused on
 * flow rather than on prompt/spinner bookkeeping.
 */

import * as clack from "@clack/prompts";
import { DeviceFlowError } from "./device-flow.ts";
import { ApiError, AuthError } from "./api.ts";
import { InsecureInstanceError } from "./instance-url.ts";

export function intro(title: string): void {
  clack.intro(title);
}

export function outro(message: string): void {
  clack.outro(message);
}

export async function askText(message: string, initialValue?: string): Promise<string> {
  const value = await clack.text({ message, initialValue });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}

export async function confirm(message: string, initialValue = true): Promise<boolean> {
  const value = await clack.confirm({ message, initialValue });
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return value;
}

export function spinner(): { start(msg: string): void; stop(msg?: string): void } {
  return clack.spinner();
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
  if (err instanceof Error) return err.message;
  return String(err);
}

export function exitWithError(err: unknown, code = 1): never {
  clack.cancel(formatError(err));
  process.exit(code);
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
