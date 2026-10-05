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
import { normalizeHttpUrl } from "@appstrate/core/url";

export interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed" | "throttled";
  models: DiscoveredModel[];
  /** The endpoint serves more than `models` lists — a cap stopped the read. */
  truncated: boolean;
}

export function discoveryErrorKey(outcome: DiscoveryState["outcome"]): string {
  switch (outcome) {
    case "auth_failed":
      return "models.form.discoverAuthFailed";
    case "blocked_url":
      return "models.form.discoverBlockedUrl";
    case "request_failed":
      return "models.form.discoverRequestFailed";
    case "throttled":
      return "models.form.discoverThrottled";
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
  { credentialId: string } | { providerId: string; api_key: string; base_url_override?: string };

export function buildDiscoverBody(input: {
  credentialId: string | null;
  provider: Pick<ProviderRegistryEntry, "providerId" | "baseUrlOverridable">;
  inlineApiKey: string;
  baseUrl: string;
}): DiscoverBody {
  if (input.credentialId) return { credentialId: input.credentialId };
  return {
    providerId: input.provider.providerId,
    api_key: input.inlineApiKey.trim(),
    ...(input.provider.baseUrlOverridable ? { base_url_override: input.baseUrl.trim() } : {}),
  };
}

/** An endpoint is reached over HTTP(S): any other scheme parses and then serves nothing. */
export function parsesAsUrl(value: string): boolean {
  return normalizeHttpUrl(value.trim()) !== null;
}
