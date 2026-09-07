// SPDX-License-Identifier: Apache-2.0

/**
 * What asking an operator's endpoint for its models answered. A request that
 * never reached the endpoint is one more outcome, so the form reads one value.
 */

import type {
  DiscoveredModel,
  DiscoveredModelsResponse,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";

export interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed";
  models: DiscoveredModel[];
}

export function discoveryErrorKey(outcome: DiscoveryState["outcome"]): string {
  switch (outcome) {
    case "auth_failed":
      return "models.form.discoverAuthFailed";
    case "blocked_url":
      return "models.form.discoverBlockedUrl";
    case "request_failed":
      return "models.form.discoverRequestFailed";
    case "rate_limited":
      return "models.form.discoverRateLimited";
    case "unreachable":
      return "models.form.discoverUnreachable";
    case "http_error":
      return "models.form.discoverHttpError";
    case "bad_response":
      return "models.form.discoverBadResponse";
    default:
      return "models.form.discoverFailed";
  }
}

/** Exactly one of the two forms; the base URL only where the provider lets it move. */
export type DiscoverBody =
  { credential_id: string } | { provider_id: string; api_key: string; base_url_override?: string };

export function buildDiscoverBody(input: {
  credentialId: string | null;
  provider: Pick<ProviderRegistryEntry, "providerId" | "baseUrlOverridable">;
  inlineApiKey: string;
  baseUrl: string;
}): DiscoverBody {
  if (input.credentialId) return { credential_id: input.credentialId };
  return {
    provider_id: input.provider.providerId,
    api_key: input.inlineApiKey.trim(),
    ...(input.provider.baseUrlOverridable ? { base_url_override: input.baseUrl.trim() } : {}),
  };
}

export function parsesAsUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}
