// SPDX-License-Identifier: Apache-2.0

/**
 * Lists spanning several spaces of the org (runs, schedules, files, the package indexes, and the
 * dashboard drawn from them): the pieces they share.
 *
 * A row of another space than the current one links to its detail with `?enterSpace=`; the
 * resolver enters that space (`useSpaceResolver`), then the route's gate drops the param
 * (`useEnterLinkedSpace`). Not `?space=`: the
 * file reader's `?org=…&space=…` names where to read WITHOUT switching.
 */

export const ENTER_SPACE_PARAM = "enterSpace";

/** `path` as it was within the current space (or for a row of no space); naming the row's space otherwise. */
export function linkedSpacePath(
  path: string,
  spaceId: string | undefined,
  currentSpaceId: string | null,
): string {
  // No current space yet: nothing to move from.
  if (!spaceId || !currentSpaceId || spaceId === currentSpaceId) return path;
  return `${path}?${new URLSearchParams({ [ENTER_SPACE_PARAM]: spaceId }).toString()}`;
}

/**
 * What `useEnterLinkedSpace` does next: wait while the resolver enters the linked space, drop the
 * param once it has. `enterable` is `undefined` while the space listing has not answered; a
 * listing that failed answers `false`, so the page renders its own state instead of waiting for
 * good.
 */
export function linkedSpaceStep(
  linked: string | null,
  current: string | null,
  enterable: boolean | undefined,
): "none" | "wait" | "drop" {
  if (!linked) return "none";
  if (enterable === undefined) return "wait";
  return enterable && current !== linked ? "wait" : "drop";
}

/** A package of an index, listed once: every space whose index lists it, `spaceId` first. */
export type InSpaces<T> = T & { spaceIds: string[] };

/**
 * One row per package of an index. The org routes answer one row per (package, space) where the
 * package is active; a list shows the package once and names its spaces. A row's spaces follow
 * `spaceOrder` (the reader's space listing), the package's home (`home_space_id`) first when it is
 * one of them. The first is the row's own `spaceId`: where its link opens. `sum`: the per-space
 * counters added up; every other field is the first space's.
 */
export function onePerPackage<
  T extends { id: string; spaceId: string; home_space_id?: string | null },
>(
  rows: readonly T[],
  spaceOrder: readonly string[],
  sum: readonly (keyof T)[] = [],
): InSpaces<T>[] {
  const rank = (spaceId: string, home: string | null | undefined) => {
    if (spaceId === home) return -1;
    const index = spaceOrder.indexOf(spaceId);
    return index < 0 ? spaceOrder.length : index;
  };
  const byPackage = new Map<string, T[]>();
  for (const row of rows) {
    const listed = byPackage.get(row.id);
    if (listed) listed.push(row);
    else byPackage.set(row.id, [row]);
  }
  return [...byPackage.values()].map((listed) => {
    const ordered = [...listed].sort(
      (a, b) => rank(a.spaceId, a.home_space_id) - rank(b.spaceId, b.home_space_id),
    );
    const totals = Object.fromEntries(
      sum.map((key) => [key, ordered.reduce((total, row) => total + (Number(row[key]) || 0), 0)]),
    );
    return { ...ordered[0]!, ...totals, spaceIds: ordered.map((row) => row.spaceId) };
  });
}

/**
 * The SSE stream is scoped to the current space: a run, schedule, file or agent list spanning
 * spaces polls while mounted, or it would never see a new row (or an agent's run counts) of another
 * space. React Query pauses it in a hidden tab.
 */
export const ACROSS_SPACES_POLL_MS = 10_000;
