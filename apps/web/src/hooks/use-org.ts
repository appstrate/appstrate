// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { orgStore } from "../stores/org-store";
import { appStore } from "../stores/app-store";
import { useAutoSelect } from "./use-auto-select";
import { orgKeys } from "../lib/query-keys";

// Reactive hook for query key usage — re-renders when org changes
export function useCurrentOrgId(): string | null {
  return useStore(orgStore, (s) => s.id);
}

async function fetchOrgs() {
  const { data } = await client.GET("/api/orgs");
  return data?.data ?? [];
}

/**
 * In-flight org list started by `primeOrgList()` at boot, waiting to be
 * adopted by the first `useOrg()` that mounts. One-shot: it is handed over
 * exactly once, and every later fetch goes through `fetchOrgs()` normally.
 */
let primedOrgs: ReturnType<typeof fetchOrgs> | null = null;

/**
 * Start the org list immediately, without waiting for React to mount the org
 * gate. `GET /api/orgs` authenticates on the session cookie alone — it needs
 * nothing from the session or profile reads — so at boot it belongs beside
 * them rather than behind them (see `main.tsx`).
 *
 * The promise is handed to React Query as the query function's own result, so
 * the query still owns the whole state machine (pending → success/error,
 * retries, gate spinner). A failure is dropped instead of being cached: the
 * common failure is "no session yet", and a poisoned `["orgs"]` entry would
 * read as an *empty* org list to `OrgGate` and bounce a legitimate user into
 * onboarding after they log in.
 */
export function primeOrgList(): void {
  const request = fetchOrgs();
  primedOrgs = request;
  request.catch(() => {
    if (primedOrgs === request) primedOrgs = null;
  });
}

function orgListQueryFn() {
  const primed = primedOrgs;
  primedOrgs = null;
  return primed ?? fetchOrgs();
}

export function useOrg() {
  const queryClient = useQueryClient();
  const currentOrgId = useStore(orgStore, (s) => s.id);

  const { data: orgs = [], isLoading } = useQuery({
    // Deliberately kept on the literal ["orgs"] key (not the typed-client
    // [method, path, init] key): it is the one query NOT wiped on org switch
    // (see the removeQueries predicate below) and other call sites invalidate
    // ["orgs"] directly. Only the fetch itself goes through the typed client.
    queryKey: orgKeys.all,
    queryFn: orgListQueryFn,
  });

  const setOrgId = useCallback((id: string) => orgStore.getState().setId(id), []);

  useAutoSelect(orgs.length > 0 ? orgs : undefined, currentOrgId, setOrgId);

  const switchOrg = useCallback(
    (orgId: string, applicationId?: string) => {
      if (orgId === orgStore.getState().id) return;
      orgStore.getState().setId(orgId);
      // A caller that already resolved the destination workspace can apply the
      // complete context in one tick. Other callers retain the resolver's
      // default-selection behaviour by omitting it.
      appStore.getState().setId(applicationId ?? null);
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
