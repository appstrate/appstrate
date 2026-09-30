// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Rejections of an unrefreshable credential count toward reconnection within this window. */
const UPSTREAM_REJECTION_WINDOW_SECONDS = 60 * 60;

/** SET expressions counting one rejection; one past the window restarts count and window. */
export function countUpstreamRejection(
  count: AnyPgColumn,
  since: AnyPgColumn,
): { failures: SQL; since: SQL } {
  const open = sql`(${since} IS NOT NULL AND ${since} > now() - make_interval(secs => ${UPSTREAM_REJECTION_WINDOW_SECONDS}))`;
  return {
    failures: sql`CASE WHEN ${open} THEN ${count} + 1 ELSE 1 END`,
    since: sql`CASE WHEN ${open} THEN ${since} ELSE now() END`,
  };
}
