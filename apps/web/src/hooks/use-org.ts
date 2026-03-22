import { useEffect, useCallback } from "react";
import { useStore } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isOwnedByOrg } from "@appstrate/core/naming";
import { api } from "../api";
import { orgStore, getCurrentOrgId } from "../stores/org-store";
import { appStore } from "../stores/app-store";
import type { OrganizationWithRole } from "@appstrate/shared-types";

// Re-export non-hook accessor so existing imports keep working (e.g. api.ts)
export { getCurrentOrgId };

// Reactive hook for query key usage — re-renders when org changes
export function useCurrentOrgId(): string | null {
  return useStore(orgStore, (s) => s.id);
}

export function useOrg() {
  const queryClient = useQueryClient();
  const currentOrgId = useStore(orgStore, (s) => s.id);

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
      orgStore.getState().setId(orgs[0].id);
    }
  }, [orgs, currentOrgId]);

  const switchOrg = useCallback(
    (orgId: string) => {
      if (orgId === orgStore.getState().id) return;
      orgStore.getState().setId(orgId);
      // Reset application selection when org changes
      appStore.getState().setId(null);
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

/** Check if a package is owned by the current org (scope matches org slug). */
export function usePackageOwnership(packageId: string | undefined) {
  const { currentOrg } = useOrg();
  if (!packageId || !currentOrg) return { isOwned: false };
  return { isOwned: isOwnedByOrg(packageId, currentOrg.slug) };
}
