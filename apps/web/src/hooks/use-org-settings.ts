// SPDX-License-Identifier: Apache-2.0

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
