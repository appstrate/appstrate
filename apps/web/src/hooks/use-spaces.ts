// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { queryClient } from "../lib/query-client";
import { getCurrentOrgId } from "../stores/org-store";
import { orgOnlyHeader, useOrgOnlyScope } from "./use-org-scope";

/** The one request init for the listing: the boot prime must land on `useSpaces`'s key. */
function spacesListInit(header: ReturnType<typeof orgOnlyHeader>) {
  return { params: { header } };
}

/** `enabled: false` for a surface that mounts the hook but needs no space list. */
export function useSpaces(enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery("get", "/api/spaces", spacesListInit(scope.header), {
    enabled: enabled && scope.enabled,
    select: (e) => e.data,
  });
}

/**
 * Start the listing at boot (`main.tsx`): every space-scoped request waits on it,
 * so waiting for the layout to mount would cost each a round trip. Keyed on the
 * remembered org, and only once the boot org list still names it: a caller
 * removed from that org would otherwise open the app on a 403. A failure is not
 * cached, `useSpaces` refetches on mount.
 */
export function primeSpaceList(orgs: Promise<readonly { id: string }[]>): void {
  orgs.then(
    (list) => {
      const orgId = getCurrentOrgId();
      if (!orgId || !list.some((org) => org.id === orgId)) return;
      void queryClient.prefetchQuery(
        $api.queryOptions("get", "/api/spaces", spacesListInit(orgOnlyHeader(orgId))),
      );
    },
    () => {},
  );
}

export function useSpace(spaceId: string) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/spaces/{id}",
    { params: { path: { id: spaceId }, header: scope.header } },
    { enabled: scope.enabled && !!spaceId },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — list and detail live under different path strings, so both need
 * invalidating after a write.
 */
function useInvalidateSpaces() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/roles"] });
    // Visibility and the default role determine implicit member rows and roles.
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/members"] });
  };
}

export function useCreateSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("post", "/api/spaces", { onSuccess: invalidate });
}

export function useUpdateSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("patch", "/api/spaces/{id}", { onSuccess: invalidate });
}

export function useDeleteSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("delete", "/api/spaces/{id}", { onSuccess: invalidate });
}

/** The transfer: an orphaned personal space becomes a team space. */
export function useConvertSpaceToTeam() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("post", "/api/spaces/{id}/convert-to-team", { onSuccess: invalidate });
}

/** Run the offboarding routine on one orphaned personal space immediately. */
export function useSweepPersonalSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("post", "/api/spaces/{id}/sweep-now", { onSuccess: invalidate });
}
