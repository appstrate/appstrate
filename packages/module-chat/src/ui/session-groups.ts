// SPDX-License-Identifier: Apache-2.0

/**
 * Date buckets of the conversation list, ChatGPT-style. Keyed on `updatedAt`
 * (the list's own order key) against LOCAL midnights, so "Hier" means the
 * user's yesterday. Boundaries are computed with calendar arithmetic, not
 * `now - 24h`, which would drift across a DST change.
 */

import type { SessionSummary } from "./sessions.ts";

/** The date buckets, in display order. */
export const SESSION_GROUP_KEYS = ["today", "yesterday", "week", "month", "older"] as const;

export type SessionGroupKey = (typeof SESSION_GROUP_KEYS)[number];

export interface SessionGroup {
  key: SessionGroupKey;
  sessions: SessionSummary[];
}

/** Local midnight `daysAgo` calendar days before `now`'s day. */
function startOfDay(now: Date, daysAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
}

/**
 * Bucket an ISO timestamp. Today ≥ midnight today; yesterday ≥ midnight
 * yesterday; "7 days" ≥ 7 days back; "30 days" ≥ 30 days back; the rest —
 * and an unparseable timestamp — is older. A future timestamp (clock skew)
 * counts as today.
 */
export function sessionGroupKey(iso: string, now: Date): SessionGroupKey {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "older";
  if (at >= startOfDay(now, 0)) return "today";
  if (at >= startOfDay(now, 1)) return "yesterday";
  if (at >= startOfDay(now, 7)) return "week";
  if (at >= startOfDay(now, 30)) return "month";
  return "older";
}

/** Non-empty groups in display order; rows keep their incoming order inside each. */
export function groupSessionsByDate(sessions: SessionSummary[], now: Date): SessionGroup[] {
  const buckets = new Map<SessionGroupKey, SessionSummary[]>();
  for (const session of sessions) {
    const key = sessionGroupKey(session.updatedAt, now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }
  return SESSION_GROUP_KEYS.flatMap((key) => {
    const group = buckets.get(key);
    return group ? [{ key, sessions: group }] : [];
  });
}
