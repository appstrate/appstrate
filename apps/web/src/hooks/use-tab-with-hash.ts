// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

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
  const setActiveTab = useCallback(
    (tab: T) => {
      navigate({ search, hash: tab === defaultTab ? "" : tab }, { replace: true });
    },
    [navigate, defaultTab, search],
  );

  return [activeTab, setActiveTab];
}
