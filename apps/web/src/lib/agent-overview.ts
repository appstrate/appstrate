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
