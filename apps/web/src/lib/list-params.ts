// SPDX-License-Identifier: Apache-2.0

// A list's filters live in the URL so Back undoes a filter. Filters are pushed (a place you
// went); the search is replaced, or typing would flood the history. `reset` is ONE update:
// several `setParams` in the same tick read the same committed location and the last wins.

import { useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

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
  if ((allowed as readonly string[]).includes(raw)) return [raw as T];
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export function useListParams(filterKeys: readonly string[]) {
  const [params, setParams] = useSearchParams();
  return urlListParams(params, setParams, filterKeys);
}

/** A detail panel has its own parameter names and keeps the selected tab in the hash. */
export function usePanelListParams(names: Readonly<Record<string, string>>) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  return urlListParams(
    params,
    (update, options) => {
      void navigate(
        { search: update(params).toString(), hash: location.hash },
        {
          ...options,
          state: location.state,
        },
      );
    },
    Object.keys(names),
    names,
  );
}

type SetParams = (
  update: (previous: URLSearchParams) => URLSearchParams,
  options?: { replace?: boolean },
) => void;

/** {@link useListParams} apart from the router hook, for its test. */
export function urlListParams(
  params: URLSearchParams,
  setParams: SetParams,
  filterKeys: readonly string[],
  names: Readonly<Record<string, string>> = {},
) {
  const name = (key: string) => names[key] ?? key;
  return {
    params,
    values<T extends string>(key: string, allowed: readonly T[]): T[] {
      return [...new Set(params.getAll(name(key)).flatMap((value) => readList(value, allowed)))];
    },
    setValues:
      (key: string) =>
      (values: string[]): void => {
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete(name(key));
          for (const value of values) next.append(name(key), value);
          return next;
        });
      },
    search: params.get(name("q")) ?? "",
    setSearch(value: string): void {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(name("q"), value);
          else next.delete(name("q"));
          return next;
        },
        { replace: true },
      );
    },
    reset(): void {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const key of new Set([...filterKeys, "q"])) next.delete(name(key));
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
