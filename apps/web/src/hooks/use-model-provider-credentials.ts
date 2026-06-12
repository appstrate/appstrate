// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { $api, type components, type paths } from "../api/client";
import { useCurrentOrgId } from "./use-org";

/** Wire shape from the OpenAPI spec (components.schemas.ModelProviderCredential). */
export type ModelProviderCredentialInfo = components["schemas"]["ModelProviderCredential"];

/** Wire shape of a `GET /api/model-provider-credentials/registry` list item. */
export type ProviderRegistryEntry =
  paths["/api/model-provider-credentials/registry"]["get"]["responses"][200]["content"]["application/json"]["data"][number];

/**
 * Org context for queries. The header is a spec-declared param passed
 * explicitly (instead of relying on the client middleware alone) so it is
 * part of the React Query key — switching org refetches instead of serving
 * another org's cached page.
 */
function useOrgScope() {
  const orgId = useCurrentOrgId();
  return {
    enabled: !!orgId,
    header: { "X-Org-Id": orgId ?? undefined },
  };
}

export function useModelProviderCredentials() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

export function useProvidersRegistry() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials/registry",
    { params: { header: scope.header } },
    { enabled: scope.enabled, staleTime: 5 * 60 * 1000, select: (e) => e.data },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — the registry is the static in-code catalog, so only the
 * credentials list needs invalidating after a write.
 */
function useInvalidateModelProviderCredentials() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/model-provider-credentials"] });
  };
}

export function useCreateModelProviderCredential() {
  const invalidate = useInvalidateModelProviderCredentials();
  return $api.useMutation("post", "/api/model-provider-credentials", { onSuccess: invalidate });
}

// `apiShape` / `baseUrl` are pinned by `providerId` at create time and cannot
// be mutated — delete and re-create to switch providers.
export function useUpdateModelProviderCredential() {
  const invalidate = useInvalidateModelProviderCredentials();
  return $api.useMutation("put", "/api/model-provider-credentials/{id}", {
    onSuccess: invalidate,
  });
}

export function useDeleteModelProviderCredential() {
  const invalidate = useInvalidateModelProviderCredentials();
  return $api.useMutation("delete", "/api/model-provider-credentials/{id}", {
    onSuccess: invalidate,
  });
}

export function useTestModelProviderCredential() {
  return $api.useMutation("post", "/api/model-provider-credentials/{id}/test");
}

export function deduplicateLabel(label: string, existingKeys: { label: string }[]): string {
  return dedupeLabel(
    label,
    existingKeys.map((k) => k.label),
  );
}

export function useTestModelProviderCredentialInline() {
  return $api.useMutation("post", "/api/model-provider-credentials/test");
}
