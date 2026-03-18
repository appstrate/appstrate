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

/** Compute next run date from a cron expression. */
export function computeNextRun(cronExpression: string, timezone: string): Date | null {
  try {
    const interval = parseExpression(cronExpression, { tz: timezone });
    return interval.next().toDate();
  } catch {
    return null;
  }
}
