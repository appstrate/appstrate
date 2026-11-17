// SPDX-License-Identifier: Apache-2.0

import { logger } from "./logger.ts";

export type BootPhase = "critical" | "serving" | "run-capacity" | "housekeeping";

export type BootStepLogger = (
  message: string,
  fields: { phase: BootPhase; step: string; durationMs: number; outcome: "ok" | "failed" },
) => void;

const defaultLog: BootStepLogger = (message, fields) => logger.info(message, fields);

/**
 * Run one boot step and log a single `Boot step` line with its duration. A
 * rejection is logged with `outcome: "failed"` and rethrown unchanged; a step
 * whose caller catches the error itself reports `ok` (its own warn says more).
 */
export async function bootStep<T>(
  phase: BootPhase,
  step: string,
  fn: () => T | Promise<T>,
  log: BootStepLogger = defaultLog,
): Promise<T> {
  const startedAt = performance.now();
  const report = (outcome: "ok" | "failed") =>
    log("Boot step", {
      phase,
      step,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome,
    });
  try {
    const result = await fn();
    report("ok");
    return result;
  } catch (err) {
    report("failed");
    throw err;
  }
}
