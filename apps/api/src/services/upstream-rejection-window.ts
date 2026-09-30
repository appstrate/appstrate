// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Upstream rejections of a credential nothing can refresh (an integration's unrefreshable auth,
 * an org's model API key) count toward reconnection within this window of the first one.
 */
const UPSTREAM_REJECTION_WINDOW_SECONDS = 60 * 60;

/**
 * The SET expressions counting one rejection: inside the window the count grows, after it the
 * rejection restarts the count and the window, so isolated rejections never add up.
 */
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
