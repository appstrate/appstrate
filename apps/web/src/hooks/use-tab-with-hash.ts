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

  const setActiveTab = useCallback(
    (tab: T) => {
      navigate({ hash: tab === defaultTab ? "" : tab }, { replace: true });
    },
    [navigate, defaultTab],
  );

  return [activeTab, setActiveTab];
}
