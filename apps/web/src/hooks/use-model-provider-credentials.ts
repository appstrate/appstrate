// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { $api, type components, type paths } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

/** Wire shape from the OpenAPI spec (components.schemas.ModelProviderCredential). */
export type ModelProviderCredentialInfo = components["schemas"]["ModelProviderCredential"];

/**
 * Wire shape of a `GET /api/model-provider-credentials/registry` list item.
 *
 * The endpoint supports the `?fields=` projection (which is why every field but
 * `providerId` is optional in the generated type). This hook never projects, so
 * the server always returns the full catalog entry — the projectable fields are
 * re-required here, asserted at the `select` trust boundary below (same pattern
 * as the integrations summary list).
 */
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

/**
 * Both reads guard on `model-provider-credentials:read`, which the agent and
 * launch surfaces mounting them do not imply.
 */
function useCredentialsReadScope() {
  const scope = useOrgOnlyScope();
  const { can } = usePermissions();
  return {
    header: scope.header,
    enabled: scope.enabled && can("model-provider-credentials:read"),
  };
}

export function useModelProviderCredentials() {
  const scope = useCredentialsReadScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

export function useProvidersRegistry() {
  const scope = useCredentialsReadScope();
  return $api.useQuery(
    "get",
    "/api/model-provider-credentials/registry",
    { params: { header: scope.header } },
    {
      enabled: scope.enabled,
      staleTime: 5 * 60 * 1000,
      // This hook never sends `?fields=`, so the server returns full entries —
      // narrow the projection-loosened wire type to the full catalog shape.
      select: (e) => e.data as ProviderRegistryEntry[],
    },
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
  return $api.useMutation("patch", "/api/model-provider-credentials/{id}", {
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

/** Wire shape of `POST /api/model-provider-credentials/discover`'s 200 body. */
export type DiscoveredModelsResponse =
  paths["/api/model-provider-credentials/discover"]["post"]["responses"][200]["content"]["application/json"];
export type DiscoveredModel = DiscoveredModelsResponse["models"][number];

/**
 * Lists what an endpoint serves, for a saved credential or for a key typed
 * inline. Persists nothing — the form reads the models straight off the
 * response, so no cache is invalidated.
 */
export function useDiscoverModels() {
  return $api.useMutation("post", "/api/model-provider-credentials/discover");
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
