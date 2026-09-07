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

export function parsesAsUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}
