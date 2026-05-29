// SPDX-License-Identifier: Apache-2.0

import { parseExpression } from "cron-parser";

/** Validate a cron expression. Returns true if valid. */
export function isValidCron(cronExpression: string): boolean {
  try {
    parseExpression(cronExpression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next run date from a cron expression, strictly after `from`
 * (defaults to now). cron-parser is forward-looking: `next()` always returns a
 * time after the base, so callers wanting to detect a missed occurrence should
 * pass a base in the past and compare the result against the present.
 */
export function computeNextRun(cronExpression: string, timezone: string, from?: Date): Date | null {
  try {
    const interval = parseExpression(cronExpression, {
      tz: timezone,
      ...(from ? { currentDate: from } : {}),
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}
