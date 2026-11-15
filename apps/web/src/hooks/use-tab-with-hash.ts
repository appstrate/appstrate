// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** A detail page's tab, kept in the URL hash. A switch is pushed, so Back undoes it. */
export function useTabWithHash<T extends string>(
  validTabs: readonly T[],
  defaultTab: T,
): [T, (tab: T) => void] {
  const location = useLocation();
  const navigate = useNavigate();

  const hash = location.hash.replace(/^#/, "");
  const activeTab = validTabs.includes(hash as T) ? (hash as T) : defaultTab;

  // `search` is passed explicitly: a partial path descriptor goes through
  // react-router's `resolvePath`, which defaults every omitted field to `""`,
  // so a bare `{ hash }` silently DROPS the query string, and with it any
  // modal or section the page keeps there.
  const search = location.search;
  // Radix reports one click twice (pointer-down, then focus) before React re-renders, so the
  // guard reads the live URL: a second identical push would leave Back on the same tab.
  const setActiveTab = useCallback(
    (tab: T) => {
      const next = tab === defaultTab ? "" : tab;
      if (window.location.hash.replace(/^#/, "") === next) return;
      navigate({ search, hash: next });
    },
    [navigate, defaultTab, search],
  );

  return [activeTab, setActiveTab];
}
