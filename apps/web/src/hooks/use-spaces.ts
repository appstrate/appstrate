// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { $api } from "../api/client";
import { invalidatePaths } from "../lib/query-keys";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { queryClient } from "../lib/query-client";
import { spaceLabel } from "../lib/space-label";
import { getCurrentOrgId } from "../stores/org-store";
import { orgOnlyHeader, useOrgOnlyScope } from "./use-org-scope";
import { invalidateIntegrationQueries } from "./use-integrations";

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

/** What to call a space of the listing, by id; `undefined` for one the caller does not reach. */
export function useSpaceLabelOf(): (id: string | null | undefined) => string | undefined {
  const { t } = useTranslation();
  const { data: spaces } = useSpaces();
  return (id) => {
    const space = spaces?.find((s) => s.id === id);
    return space && spaceLabel(space, t);
  };
}

/**
 * Start the listing at boot (`main.tsx`): every space-scoped request waits on it. Only once the
 * boot org list still names the remembered org (a removed caller would open the app on a 403).
 * A failure is not cached; `useSpaces` refetches on mount.
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

/** The listing of an org the caller belongs to, current or not: same key as `useSpaces` for the current one. */
export function useOrgSpaces(orgId: string | null) {
  return $api.useQuery("get", "/api/spaces", spacesListInit(orgOnlyHeader(orgId)), {
    enabled: !!orgId,
    select: (e) => e.data,
  });
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

/** List and detail are different path strings; visibility and the default role determine implicit member rows, which each org member also carries (`/api/orgs/{orgId}`). */
const useInvalidateSpaces = () =>
  useInvalidatePaths(
    "/api/spaces",
    "/api/spaces/{id}",
    "/api/spaces/{id}/roles",
    "/api/spaces/{id}/members",
    "/api/orgs/{orgId}",
  );

export function useCreateSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("post", "/api/spaces", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useUpdateSpace() {
  const invalidate = useInvalidateSpaces();
  const qc = useQueryClient();
  return $api.useMutation("patch", "/api/spaces/{id}", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => {
      invalidate();
      // Closing the space unshares the connections of owners it leaves without access.
      void invalidateIntegrationQueries(qc);
    },
  });
}

export function useDeleteSpace() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/spaces/{id}", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => {
      // Each org member lists the spaces they reach.
      void invalidatePaths(qc, ["/api/spaces", "/api/orgs/{orgId}"]);
      // The page still showing the deleted space would re-read it, a 404: stale only.
      void invalidatePaths(
        qc,
        ["/api/spaces/{id}", "/api/spaces/{id}/roles", "/api/spaces/{id}/members"],
        "none",
      );
    },
  });
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
