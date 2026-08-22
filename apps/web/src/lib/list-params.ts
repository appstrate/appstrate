// SPDX-License-Identifier: Apache-2.0

/**
 * A list's filters, held in the URL rather than in the component.
 *
 * A filtered list is what people paste to each other, and the rule that gave
 * modals real URLs brings the same obligation here: Back has to undo a filter.
 * That was written once for the runs page and would have been written a second
 * time, word for word, the moment a second screen learned to filter.
 *
 * Two behaviours are the whole reason this is not four lines at each call site:
 *
 * - **Pushed, not replaced** — a filter is a place you went.
 * - **Except the search, which is replaced**: typing eight characters would
 *   otherwise put eight entries in the history and make Back useless.
 *
 * And `reset` is ONE update, not one per dimension. Three `setParams` in the
 * same tick each read the same committed location, so the last would win and
 * the other two filters would survive a "Réinitialiser" that looked like it
 * worked. That bug is why this function exists at all rather than a loop at
 * the call site.
 */

import { useSearchParams } from "react-router-dom";

/** Only the values the screen declares — a URL is user input. */
export function readList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function useListParams(filterKeys: readonly string[]) {
  const [params, setParams] = useSearchParams();

  return {
    params,
    /** The chosen values of one dimension, narrowed to what the screen allows. */
    values<T extends string>(key: string, allowed: readonly T[]): T[] {
      return readList(params.get(key), allowed);
    },
    setValues:
      (key: string) =>
      (values: string[]): void => {
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          if (values.length === 0) next.delete(key);
          else next.set(key, values.join(","));
          return next;
        });
      },
    search: params.get("q") ?? "",
    setSearch(value: string): void {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set("q", value);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    },
    reset(): void {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const key of [...filterKeys, "q"]) next.delete(key);
        return next;
      });
    },
  };
}
