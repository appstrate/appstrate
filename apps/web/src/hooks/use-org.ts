// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isOwnedByOrg } from "@appstrate/core/naming";
import { apiList } from "../api";
import { orgStore, getCurrentOrgId } from "../stores/org-store";
import { appStore } from "../stores/app-store";
import { useAutoSelect } from "./use-auto-select";
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
    queryFn: () => apiList<OrganizationWithRole>("/orgs"),
  });

  const setOrgId = useCallback((id: string) => orgStore.getState().setId(id), []);

  useAutoSelect(orgs.length > 0 ? orgs : undefined, currentOrgId, setOrgId);

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
    isOrgOwner: currentOrg?.role === "owner",
  };
}

/** Check if a package is owned by the current org (scope matches org slug). */
export function usePackageOwnership(packageId: string | undefined) {
  const { currentOrg } = useOrg();
  if (!packageId || !currentOrg) return { isOwned: false };
  return { isOwned: isOwnedByOrg(packageId, currentOrg.slug) };
}
