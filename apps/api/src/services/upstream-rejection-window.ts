// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Upstream rejections of an unrefreshable credential keep counting toward reconnection while
 * each follows the previous one within this many days: a daily schedule (one counted rejection
 * per run) still reaches the threshold, while rejections months apart never add up.
 */
export const UPSTREAM_REJECTION_GAP_DAYS = 7;

/** SET expressions counting one rejection; `since` holds the last counted one, and a longer gap restarts at 1. */
export function countUpstreamRejection(
  count: AnyPgColumn,
  since: AnyPgColumn,
): { failures: SQL; since: SQL } {
  const recent = sql`(${since} IS NOT NULL AND ${since} > now() - make_interval(days => ${UPSTREAM_REJECTION_GAP_DAYS}))`;
  return {
    failures: sql`CASE WHEN ${recent} THEN ${count} + 1 ELSE 1 END`,
    since: sql`now()`,
  };
}
