// SPDX-License-Identifier: Apache-2.0

import type {
  DiscoveredModel,
  DiscoveredModelsResponse,
} from "../hooks/use-model-provider-credentials";
import { normalizeHttpUrl } from "@appstrate/core/url";

/** What asking an endpoint for its models answered; a request that never reached it is one more outcome. */
export interface DiscoveryState {
  /** Identifies the endpoint+key the listing came from — see `discoveryKey`. */
  key: string;
  outcome: DiscoveredModelsResponse["outcome"] | "request_failed" | "throttled";
  models: DiscoveredModel[];
  /** A cap stopped the read: the endpoint serves more than `models` lists. */
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

/**
 * Exactly one of the two forms: a saved organization key (it carries key and endpoint), or a key
 * typed for this one request, against the configuration's endpoint.
 */
export type DiscoverBody =
  { credentialId: string } | { providerId: string; api_key: string; config_id: string };

export function buildDiscoverBody(input: {
  credentialId: string | null;
  providerId: string;
  configId: string;
  inlineApiKey: string;
}): DiscoverBody {
  if (input.credentialId) return { credentialId: input.credentialId };
  return {
    providerId: input.providerId,
    api_key: input.inlineApiKey.trim(),
    config_id: input.configId,
  };
}

/** An endpoint is reached over HTTP(S): any other scheme parses and then serves nothing. */
export function parsesAsUrl(value: string): boolean {
  return normalizeHttpUrl(value.trim()) !== null;
}
