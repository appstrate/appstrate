// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { useCurrentOrgId } from "./use-org";

export function useOrgSettings() {
  const orgId = useCurrentOrgId();
  return $api.useQuery(
    "get",
    "/api/orgs/{orgId}/settings",
    // orgId is part of the typed query key via the path param, so switching
    // org refetches instead of serving the previous org's settings.
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );
}

export function useUpdateOrgSettings() {
  const invalidate = useInvalidatePaths("/api/orgs/{orgId}/settings");
  return $api.useMutation("patch", "/api/orgs/{orgId}/settings", { onSuccess: invalidate });
}

/**
 * What setting `role` as the org's personal-space default would stop, read on demand when the admin
 * picks it, never served from the cache: each pick judges the schedules as they are now.
 */
export function usePersonalSpaceRoleImpact() {
  const queryClient = useQueryClient();
  const orgId = useCurrentOrgId();
  return (role: string) =>
    queryClient.fetchQuery({
      ...$api.queryOptions("get", "/api/orgs/{orgId}/personal-space-role/impact", {
        params: { path: { orgId: orgId ?? "" }, query: { role } },
      }),
      staleTime: 0,
      gcTime: 0,
    });
}
