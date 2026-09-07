// SPDX-License-Identifier: Apache-2.0

/**
 * What asking an operator's endpoint for its models answered.
 *
 * The outcomes are flattened — a request that never reached the endpoint is one
 * more of them — so the form reads a single value and every failure has copy
 * that names what to fix rather than a generic apology.
 */

import type {
  DiscoveredModel,
  DiscoveredModelsResponse,
} from "../hooks/use-model-provider-credentials";

export interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed";
  models: DiscoveredModel[];
}

/** The line under the discovery button when no listing came back. */
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

/** The registry facts the discovery body turns on — an entry fits. */
export interface DiscoverProvider {
  providerId: string;
  baseUrlOverridable: boolean;
}

/**
 * `POST /api/model-provider-credentials/discover` takes exactly one of two
 * forms, never both: a saved credential names its own endpoint and key, and an
 * inline key has to describe the endpoint it opens. The base URL rides along
 * only where the provider lets the operator move it — a pinned provider
 * answers on its own `defaultBaseUrl` and the route refuses the field.
 */
export type DiscoverBody =
  { credential_id: string } | { provider_id: string; api_key: string; base_url_override?: string };

export function buildDiscoverBody(input: {
  credentialId: string | null;
  provider: DiscoverProvider;
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
