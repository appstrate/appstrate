// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type MutationMeta, type QueryClient } from "@tanstack/react-query";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { $api, type components, type paths } from "../api/client";
import { invalidatePaths } from "../lib/query-keys";
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
      | "personal_allowed"
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

export function useModelProviderCredentials() {
  const scope = useCredentialsScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
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

/** `meta`: the model form reports a refused inline key itself; the key dialog leaves it to the cache. */
export function useCreateModelProviderCredential(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths("/api/model-provider-credentials");
  return $api.useMutation("post", "/api/model-provider-credentials", {
    meta,
    onSuccess: invalidate,
  });
}

// `apiShape` / `baseUrl` are pinned by `providerId` at create time and cannot
// be mutated — delete and re-create to switch providers.
export function useUpdateModelProviderCredential() {
  const invalidate = useInvalidatePaths("/api/model-provider-credentials");
  return $api.useMutation("patch", "/api/model-provider-credentials/{id}", {
    onSuccess: invalidate,
  });
}

/** `meta`: deleting an organization key with its models reports its own failures. */
export function useDeleteModelProviderCredential(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths("/api/model-provider-credentials");
  return $api.useMutation("delete", "/api/model-provider-credentials/{id}", {
    meta,
    onSuccess: invalidate,
  });
}

/** Re-read the credentials and the models they serve: a test may rotate or flag a subscription, a pairing adds one, a personal-key switch changes which serve a call. */
export async function invalidateCredentialsAndModels(qc: QueryClient): Promise<void> {
  await invalidatePaths(qc, ["/api/model-provider-credentials", "/api/models"]);
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

export function deduplicateLabel(label: string, existingKeys: { label: string }[]): string {
  return dedupeLabel(
    label,
    existingKeys.map((k) => k.label),
  );
}

export function useTestModelProviderCredentialInline() {
  return $api.useMutation("post", "/api/model-provider-credentials/test", {
    meta: { errorHandledByCaller: true },
  });
}
