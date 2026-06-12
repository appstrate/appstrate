// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";

/** Wire shape from the OpenAPI spec (components.schemas.ApplicationObject). */
export type ApplicationInfo = components["schemas"]["ApplicationObject"];

export function useApplications() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/applications",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

export function useApplication(applicationId: string) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/applications/{id}",
    { params: { path: { id: applicationId }, header: scope.header } },
    { enabled: scope.enabled && !!applicationId },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — list and detail live under different path strings, so both need
 * invalidating after a write.
 */
function useInvalidateApplications() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/applications"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/applications/{id}"] });
  };
}

export function useCreateApplication() {
  const invalidate = useInvalidateApplications();
  return $api.useMutation("post", "/api/applications", { onSuccess: invalidate });
}

export function useUpdateApplication() {
  const invalidate = useInvalidateApplications();
  return $api.useMutation("patch", "/api/applications/{id}", { onSuccess: invalidate });
}

export function useDeleteApplication() {
  const invalidate = useInvalidateApplications();
  return $api.useMutation("delete", "/api/applications/{id}", { onSuccess: invalidate });
}
