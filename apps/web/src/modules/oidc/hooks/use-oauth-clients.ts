// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the OIDC module's OAuth client admin API.
 * Mirrors the backend `/api/oauth/clients*` routes shipped in Stage 4.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client, type components, type paths } from "@/api/client";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentSpaceId } from "@/hooks/use-current-space";
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
        // Space-level clients are org-wide on the wire — scope them to
        // the currently-selected space so the tab never shows clients
        // that belong to a sibling space in the same org.
        return level === "space" ? byLevel.filter((c) => c.referencedSpaceId === spaceId) : byLevel;
      },
    },
  );
}

/**
 * Canonical scope vocabulary served by `GET /api/oauth/scopes`. Used by
 * the create-client modal checkbox group so the frontend never hardcodes
 * scope strings.
 */
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

function useInvalidateOAuthClients() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/oauth/clients"] });
  };
}

export function useCreateOAuthClient(level?: "org" | "space") {
  const invalidate = useInvalidateOAuthClients();
  const spaceId = useCurrentSpaceId();
  const orgId = useCurrentOrgId();
  const isOrg = level === "org";
  return useMutation({
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
    }) => {
      // The level discriminator and pinned reference come from the current
      // org/space context — call sites only provide the client fields.
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

export function useUpdateOAuthClient() {
  const invalidate = useInvalidateOAuthClients();
  return $api.useMutation("patch", "/api/oauth/clients/{clientId}", { onSuccess: invalidate });
}

export function useDeleteOAuthClient() {
  const invalidate = useInvalidateOAuthClients();
  return $api.useMutation("delete", "/api/oauth/clients/{clientId}", { onSuccess: invalidate });
}

export function useRotateOAuthClientSecret() {
  const invalidate = useInvalidateOAuthClients();
  return $api.useMutation("post", "/api/oauth/clients/{clientId}/rotate", {
    onSuccess: invalidate,
  });
}
