// SPDX-License-Identifier: Apache-2.0

/** React Query hooks for the OIDC module's OAuth client admin API (`/api/oauth/clients*`). */

import { useMutation, type MutationMeta } from "@tanstack/react-query";
import { $api, client, type components, type paths } from "@/api/client";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentSpaceId } from "@/hooks/use-current-space";
import { useInvalidatePaths } from "@/hooks/use-invalidate-paths";
import { useOrgOnlyScope } from "@/hooks/use-org-scope";
import type { AssignableOrgRole } from "@appstrate/shared-types";

/** Wire shapes from the OpenAPI spec. */
export type OAuthClient = components["schemas"]["OAuthClientObject"];

type CreateOAuthClientBody =
  paths["/api/oauth/clients"]["post"]["requestBody"]["content"]["application/json"];

export function useOAuthClients(level?: "org" | "space") {
  const scope = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  const isOrg = level === "org";
  return $api.useQuery(
    "get",
    "/api/oauth/clients",
    { params: { header: scope.header } },
    {
      enabled: isOrg ? scope.enabled : scope.enabled && !!spaceId,
      select: (e) => {
        if (!level) return e.data;
        const byLevel = e.data.filter((c) => c.level === level);
        // Space-level clients are org-wide on the wire: keep the current space's only.
        return level === "space" ? byLevel.filter((c) => c.referencedSpaceId === spaceId) : byLevel;
      },
    },
  );
}

/** Scope vocabulary from `GET /api/oauth/scopes`, so the frontend never hardcodes scope strings. */
export function useOAuthScopes() {
  const scope = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/oauth/scopes",
    { params: { header: scope.header } },
    {
      enabled: scope.enabled && !!spaceId,
      staleTime: Infinity, // scope list is static within a deploy
      select: (e) => e.data,
    },
  );
}

export function useCreateOAuthClient(level?: "org" | "space") {
  const invalidate = useInvalidatePaths("/api/oauth/clients");
  const spaceId = useCurrentSpaceId();
  const orgId = useCurrentOrgId();
  const isOrg = level === "org";
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async (data: {
      name: string;
      redirectUris: string[];
      postLogoutRedirectUris?: string[];
      scopes?: string[];
      isFirstParty?: boolean;
      /** Unified signup opt-in (instance/org/space). */
      allowSignup?: boolean;
      /** Org-level only — role assigned on auto-join. `owner` forbidden. */
      signupRole?: AssignableOrgRole;
      signupSpaceAssignments?: components["schemas"]["SpaceAssignment"][];
    }) => {
      const body: CreateOAuthClientBody = isOrg
        ? { level: "org", referencedOrgId: orgId!, ...data }
        : { level: "space", referencedSpaceId: spaceId!, ...data };
      const { data: created } = await client.POST("/api/oauth/clients", { body });
      if (!created) throw new Error("empty response");
      return created;
    },
    onSuccess: invalidate,
  });
}

/** `meta`: the edit form shows a refusal on itself; the list's toggles leave it to the cache. */
export function useUpdateOAuthClient(meta?: MutationMeta) {
  const invalidate = useInvalidatePaths("/api/oauth/clients");
  return $api.useMutation("patch", "/api/oauth/clients/{clientId}", {
    meta,
    onSuccess: invalidate,
  });
}

export function useDeleteOAuthClient() {
  const invalidate = useInvalidatePaths("/api/oauth/clients");
  return $api.useMutation("delete", "/api/oauth/clients/{clientId}", { onSuccess: invalidate });
}

export function useRotateOAuthClientSecret() {
  const invalidate = useInvalidatePaths("/api/oauth/clients");
  return $api.useMutation("post", "/api/oauth/clients/{clientId}/rotate", {
    onSuccess: invalidate,
  });
}
