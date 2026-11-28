// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type MutationMeta, type QueryClient } from "@tanstack/react-query";
import { $api, type components, type paths } from "../api/client";
import { invalidatePaths, MODEL_CACHE_PATHS } from "../lib/query-keys";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { useOrgOnlyScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

/** Wire shape from the OpenAPI spec (components.schemas.ModelProviderCredential). */
export type ModelProviderCredentialInfo = components["schemas"]["ModelProviderCredential"];

/** Wire shape of a registry list item. `?fields=` projection makes all but `providerId` optional; this hook never projects, so they are re-required here (asserted in `select`). */
type RawProviderRegistryEntry =
  paths["/api/model-provider-credentials/registry"]["get"]["responses"][200]["content"]["application/json"]["data"][number];
export type ProviderRegistryEntry = RawProviderRegistryEntry &
  Required<
    Pick<
      RawProviderRegistryEntry,
      | "displayName"
      | "iconUrl"
      | "apiShape"
      | "defaultBaseUrl"
      | "baseUrlOverridable"
      | "authMode"
      | "featured"
      | "live_model_search"
      | "models"
    >
  >;

/** Both reads open to `read` (every org credential) or `connect` (the server lists only the caller's own personal ones). */
function useCredentialsScope() {
  const scope = useOrgOnlyScope();
  const { can } = usePermissions();
  return {
    header: scope.header,
    enabled:
      scope.enabled &&
      (can("model-provider-credentials:read") || can("model-provider-credentials:connect")),
  };
}

export function useModelProviderCredentials(refetchOnWindowFocus: false | "always" = false) {
  const scope = useCredentialsScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data, refetchOnWindowFocus },
  );
}

export function useProvidersRegistry() {
  const scope = useCredentialsScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials/registry",
    { params: { header: scope.header } },
    {
      enabled: scope.enabled,
      staleTime: 5 * 60 * 1000,
      // No `?fields=` is sent: narrow the projection-loosened type to the full entry.
      select: (e) => e.data as ProviderRegistryEntry[],
    },
  );
}

/** `meta`: the key form reports a refusal itself. */
export function useCreateModelProviderCredential(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("post", "/api/model-provider-credentials", {
    meta,
    onSuccess: invalidate,
  });
}

// `apiShape` / `baseUrl` are pinned by `providerId` at create time and cannot
// be mutated — delete and re-create to switch providers.
/** `meta`: the key form shows its refusal inline; a rename reports through the cache. */
export function useUpdateModelProviderCredential(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("patch", "/api/model-provider-credentials/{id}", {
    meta,
    onSuccess: invalidate,
  });
}

export function useDeleteModelProviderCredential() {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  return $api.useMutation("delete", "/api/model-provider-credentials/{id}", {
    onSuccess: invalidate,
  });
}

/** Re-read the connections, the configurations and the models they serve: a test may rotate or flag a subscription, a pairing adds one. */
export async function invalidateCredentialsAndModels(qc: QueryClient): Promise<void> {
  await invalidatePaths(qc, [...MODEL_CACHE_PATHS]);
}

export function useTestModelProviderCredential() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/model-provider-credentials/{id}/test", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => invalidateCredentialsAndModels(qc),
  });
}

/** Wire shape of `POST /api/model-provider-credentials/discover`'s 200 body. */
export type DiscoveredModelsResponse =
  paths["/api/model-provider-credentials/discover"]["post"]["responses"][200]["content"]["application/json"];
export type DiscoveredModel = DiscoveredModelsResponse["models"][number];

/** Lists what an endpoint serves, for a saved credential or an inline key. Persists nothing, so no cache is invalidated. */
export function useDiscoverModels() {
  return $api.useMutation("post", "/api/model-provider-credentials/discover", {
    meta: { errorHandledByCaller: true },
  });
}

export function useTestModelProviderCredentialInline() {
  return $api.useMutation("post", "/api/model-provider-credentials/test", {
    meta: { errorHandledByCaller: true },
  });
}
