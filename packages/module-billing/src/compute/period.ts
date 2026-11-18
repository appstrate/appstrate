// SPDX-License-Identifier: Apache-2.0

/**
 * The pure arithmetic of the compute-minutes quota: how a finished run turns into seconds,
 * and which calendar month a moment belongs to. No database, no clock read, no config —
 * the settlement pass, the admission gate and the dashboard projection all read it, so there
 * is exactly one place the rounding rule and the month boundary can drift.
 */

import type { TerminalRunRow } from "@appstrate/core/module";

export const SECONDS_PER_MINUTE = 60;

/**
 * What a finished run costs the quota, in whole seconds.
 *
 * - **Rounded UP to the second, no minimum.** A 40 s run consumes 40 s; a 400 ms run
 *   consumes 1 s; a run that recorded 0 ms consumes nothing. The quota is displayed in
 *   minutes but consumed to the second.
 * - **A remote run counts for nothing.** Its compute is the caller's own host: the platform
 *   orchestrated it and supplied no slot. It is still claimed (see `settleTerminalRuns`) so
 *   the audit shows it was seen and valued at zero.
 * - **A run that recorded no duration counts for nothing**, rather than for a guess.
 *
 * The figure is `runs.duration`, which the platform stamps from the runner's own loop (boot
 * and cold start excluded) and, when the runner posted none, from the moment the run left
 * the queue; time waiting for a slot is not in it. Waiting on a model or a service while
 * the sandbox is up IS in it: the environment is occupied.
 */
export function billableSeconds(run: Pick<TerminalRunRow, "runOrigin" | "durationMs">): number {
  if (run.runOrigin !== "platform") return 0;
  const ms = run.durationMs;
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 1000);
}

/** First day (`YYYY-MM-01`) of the UTC calendar month `at` falls in — the `period_start` key. */
export function periodStartOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The instant the month starting at `periodStart` ends — when the next one begins. */
export function periodEndOf(periodStart: string): Date {
  const [year, month] = periodStart.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1));
}
