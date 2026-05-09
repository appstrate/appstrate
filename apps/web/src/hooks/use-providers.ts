// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { ProviderConfig } from "@appstrate/shared-types";

/**
 * List configured providers for the current application. Uses the standard
 * Stripe-canonical list envelope via `apiList`, so the hook returns a plain
 * `ProviderConfig[]` — same shape as every other list hook in the app.
 *
 * The `/providers` endpoint also returns a top-level `callbackUrl` field
 * (the OAuth redirect URI for the platform). That field is exposed by the
 * separate `useProviderCallbackUrl()` hook below, since most consumers don't
 * need it.
 */
export function useProviders() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["providers", orgId, appId],
    queryFn: () => apiList<ProviderConfig>("/providers"),
    enabled: !!orgId && !!appId,
  });
}

interface ProvidersEnvelopeWithCallback {
  object: "list";
  data: ProviderConfig[];
  hasMore: boolean;
  callbackUrl?: string;
}

/**
 * Read the platform's OAuth callback URL from the `/providers` envelope.
 * Only consumed by provider-credentials forms (OAuth setup screens).
 */
export function useProviderCallbackUrl() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["providers", "callback-url", orgId, appId],
    queryFn: async () => {
      const env = await api<ProvidersEnvelopeWithCallback>("/providers");
      return env.callbackUrl;
    },
    enabled: !!orgId && !!appId,
  });
}
