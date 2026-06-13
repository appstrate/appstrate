// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import type { OrgSettings } from "@appstrate/shared-types";
import { $api } from "../api/client";
import { useCurrentOrgId } from "./use-org";

export type { OrgSettings };

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
  const queryClient = useQueryClient();
  return $api.useMutation("put", "/api/orgs/{orgId}/settings", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["get", "/api/orgs/{orgId}/settings"] });
    },
  });
}
