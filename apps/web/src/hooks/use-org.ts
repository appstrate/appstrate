// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { VIEW_AS_HEADER } from "@appstrate/core/permissions";
import { $api, client } from "../api/client";
import { orgStore } from "../stores/org-store";
import { spaceStore } from "../stores/space-store";
import { exitViewAs, serializeViewAs, type ViewAsPersona } from "../stores/view-as-store";
import { useAutoSelect } from "./use-auto-select";
import {
  invalidateOrgDetail,
  invalidatePaths,
  orgKeys,
  removeOrgScopedQueries,
} from "../lib/query-keys";
import { invalidateIntegrationQueries } from "./use-integrations";
import { viewAsRefusalCode } from "../lib/view-as-refusal";

// Reactive hook for query key usage — re-renders when org changes
export function useCurrentOrgId(): string | null {
  return useStore(orgStore, (s) => s.id);
}

/** The current org's detail (members, invitations, storage): one cache entry for every reader. */
export function useOrgDetail(options?: { enabled?: boolean }) {
  const orgId = useCurrentOrgId();
  return $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: (options?.enabled ?? true) && !!orgId },
  );
}

/** Invitations: the write refreshes the org detail that lists them. */
export function useInviteMember() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/orgs/{orgId}/members", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => void invalidateOrgDetail(qc),
  });
}

export function useUpdateInvitation() {
  const qc = useQueryClient();
  return $api.useMutation("patch", "/api/orgs/{orgId}/invitations/{invitationId}", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => void invalidateOrgDetail(qc),
  });
}

export function useCancelInvitation() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/orgs/{orgId}/invitations/{invitationId}", {
    onSuccess: () => void invalidateOrgDetail(qc),
  });
}

/**
 * What an org-role change or a removal touches beyond the org: a promotion deletes the
 * explicit space roles, a removal the space seats, and a drop that ends space access
 * unshares the member's connections.
 */
export function invalidateMemberWrite(queryClient: QueryClient): void {
  void invalidateOrgDetail(queryClient);
  void invalidatePaths(queryClient, ["/api/spaces/{id}/members"]);
  void invalidateIntegrationQueries(queryClient);
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: () => invalidateMemberWrite(qc),
  });
}

export function useChangeMemberRole() {
  const qc = useQueryClient();
  return $api.useMutation("put", "/api/orgs/{orgId}/members/{userId}", {
    onSuccess: () => invalidateMemberWrite(qc),
  });
}

async function requestOrgs(viewAs?: string) {
  const { data } = await client.GET(
    "/api/orgs",
    viewAs ? { params: { header: { [VIEW_AS_HEADER]: viewAs } } } : {},
  );
  return data?.data ?? [];
}

/**
 * A refused role preview is ended by the response middleware while its read fails: asked again
 * without the persona, it answers. Done in the read, not as a query retry (which pauses for good
 * in an unfocused tab, leaving the org gate an empty list). Exported for its test.
 */
export async function readPastRefusedPreview<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (viewAsRefusalCode(error) === null) throw error;
    return read();
  }
}

/** The caller's org list, boot prime and mounted query alike. */
function fetchOrgs() {
  return readPastRefusedPreview(() => requestOrgs());
}

type OrgList = Awaited<ReturnType<typeof requestOrgs>>;

/**
 * The org listing as answered FOR `persona` (the `permissions` every `can()` reads). The store
 * does not hold the persona yet on purpose: `enterViewAs` commits both together, so nothing
 * renders the previewer's authority under the persona's banner.
 */
export function fetchOrgsAs(persona: ViewAsPersona) {
  return requestOrgs(serializeViewAs(persona));
}

/** In-flight list from `primeOrgList()`, adopted once by the first `useOrg()` to mount. */
let primedOrgs: ReturnType<typeof fetchOrgs> | null = null;

/**
 * Start the org list at boot (see `main.tsx`) without waiting for the org gate: `GET /api/orgs`
 * needs only the session cookie. The query adopts the promise as its own result. A failure is
 * dropped, not cached: a poisoned `["orgs"]` entry would read as an empty list and bounce a
 * legitimate user into onboarding after login.
 */
export function primeOrgList(): Promise<OrgList> {
  const request = fetchOrgs();
  primedOrgs = request;
  request.catch(() => {
    if (primedOrgs === request) primedOrgs = null;
  });
  return request;
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
    // The one query NOT wiped on org switch, invalidated by name: a literal key, not the typed one.
    queryKey: orgKeys.all,
    queryFn: orgListQueryFn,
  });

  const setOrgId = useCallback((id: string) => orgStore.getState().setId(id), []);

  useAutoSelect(orgs.length > 0 ? orgs : undefined, currentOrgId, setOrgId);

  const selectOrg = useCallback(
    (orgId: string | null) => {
      // A persona is validated in ONE organization; it must not carry across.
      exitViewAs();
      orgStore.getState().setId(orgId);
      spaceStore.getState().setId(null);
      removeOrgScopedQueries(queryClient);
    },
    [queryClient],
  );

  const switchOrg = useCallback(
    (orgId: string) => {
      if (orgId !== orgStore.getState().id) selectOrg(orgId);
    },
    [selectOrg],
  );

  /** Step out of an org the caller left or deleted; dropped from the cache first so auto-select cannot re-pick it. */
  const forgetOrg = useCallback(
    (orgId: string) => {
      const remaining = (queryClient.getQueryData<OrgList>(orgKeys.all) ?? []).filter(
        (o) => o.id !== orgId,
      );
      queryClient.setQueryData<OrgList>(orgKeys.all, remaining);
      selectOrg(remaining[0]?.id ?? null);
      void queryClient.invalidateQueries({ queryKey: orgKeys.all });
    },
    [queryClient, selectOrg],
  );

  const currentOrg = orgs.find((o) => o.id === currentOrgId) ?? null;

  return {
    currentOrg,
    orgs,
    switchOrg,
    forgetOrg,
    loading: isLoading,
  };
}
