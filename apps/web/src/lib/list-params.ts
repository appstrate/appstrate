// SPDX-License-Identifier: Apache-2.0

// A list's filters live in the URL so Back undoes a filter. Filters are pushed (a place you
// went); the search is replaced, or typing would flood the history. `reset` is ONE update:
// several `setParams` in the same tick read the same committed location and the last wins.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";

/** A page keeps it in the URL ({@link useListParams}); a list inside a page keeps it locally ({@link useLocalListParams}) or both would write the page's `?q=`. */
export interface ListState {
  search: string;
  setSearch: (value: string) => void;
  values<T extends string>(key: string, allowed: readonly T[]): T[];
  setValues: (key: string) => (values: string[]) => void;
  reset: () => void;
}

/** Only the values the screen declares — a URL is user input. */
export function readList<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function useListParams(filterKeys: readonly string[]) {
  const [params, setParams] = useSearchParams();
  return urlListParams(params, setParams, filterKeys);
}

type SetParams = ReturnType<typeof useSearchParams>[1];

/** {@link useListParams} apart from the router hook, for its test. */
export function urlListParams(
  params: URLSearchParams,
  setParams: SetParams,
  filterKeys: readonly string[],
) {
  return {
    params,
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

/** For a panel with no URL of its own. `initial` is the filter it opens on; `reset` clears it too. */
export function useLocalListParams(initial: Record<string, string[]> = {}): ListState {
  const [search, setSearch] = useState("");
  const [values, setValues] = useState<Record<string, string[]>>(initial);

  return {
    search,
    setSearch,
    values<T extends string>(key: string, allowed: readonly T[]): T[] {
      return (values[key] ?? []).filter((v): v is T => (allowed as readonly string[]).includes(v));
    },
    setValues: (key: string) => (next: string[]) => setValues((prev) => ({ ...prev, [key]: next })),
    reset: () => {
      setSearch("");
      setValues({});
    },
  };
}
