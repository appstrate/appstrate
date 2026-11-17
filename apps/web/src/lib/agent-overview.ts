// SPDX-License-Identifier: Apache-2.0

/** The most recent write across both memory tiers: a pinned slot's update or creation, an archive entry's creation. */
export function latestMemoryDate(
  pinned: readonly { updatedAt: string | null; createdAt: string | null }[],
  memories: readonly { createdAt: string | null }[],
): string | undefined {
  return [
    ...pinned.flatMap((item) => [item.updatedAt, item.createdAt]),
    ...memories.map((item) => item.createdAt),
  ]
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/** The share of successes among runs that ended in success, failure or timeout; `null` before any. */
export function runSuccessRate(activity: {
  success: number;
  failed: number;
  timeout: number;
}): number | null {
  const finished = activity.success + activity.failed + activity.timeout;
  return finished > 0 ? activity.success / finished : null;
}
