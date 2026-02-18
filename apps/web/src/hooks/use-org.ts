import { useSyncExternalStore, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { OrganizationWithRole } from "@appstrate/shared-types";

// ---------------------------------------------------------------------------
// Module-level store for current org ID (useSyncExternalStore pattern)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "appstrate_current_org";

let _currentOrgId: string | null = localStorage.getItem(STORAGE_KEY);
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): string | null {
  return _currentOrgId;
}

function setCurrentOrgId(orgId: string | null) {
  _currentOrgId = orgId;
  if (orgId) {
    localStorage.setItem(STORAGE_KEY, orgId);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  for (const fn of listeners) fn();
}

// Sync with external localStorage changes (other tabs)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      _currentOrgId = e.newValue;
      for (const fn of listeners) fn();
    }
  });
}

// ---------------------------------------------------------------------------
// Public non-hook accessor (for api.ts to inject X-Org-Id header)
// ---------------------------------------------------------------------------

export function getCurrentOrgId(): string | null {
  return _currentOrgId;
}

// Reactive hook for query key usage — re-renders when org changes
export function useCurrentOrgId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOrg() {
  const queryClient = useQueryClient();
  const currentOrgId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => {
      const data = await api<{ organizations: OrganizationWithRole[] }>("/orgs");
      return data.organizations;
    },
  });

  // Auto-select first org when only one and none selected, or when the
  // currently-stored org ID is no longer in the user's org list.
  useEffect(() => {
    if (orgs.length === 0) return;

    const storedId = currentOrgId;
    const storedExists = storedId && orgs.some((o) => o.id === storedId);

    if (!storedExists) {
      setCurrentOrgId(orgs[0].id);
    }
  }, [orgs, currentOrgId]);

  const switchOrg = useCallback(
    (orgId: string) => {
      if (orgId === _currentOrgId) return;
      setCurrentOrgId(orgId);
      // Clear all cached data since it is org-scoped
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "orgs" });
    },
    [queryClient],
  );

  const currentOrg = orgs.find((o) => o.id === currentOrgId) ?? null;

  return {
    currentOrg,
    orgs,
    switchOrg,
    loading: isLoading,
    isOrgAdmin: currentOrg?.role === "owner" || currentOrg?.role === "admin",
    isOrgOwner: currentOrg?.role === "owner",
  };
}
