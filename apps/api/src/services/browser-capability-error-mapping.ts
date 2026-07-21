// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../lib/errors.ts";
import { BrowserCapabilityPolicyError } from "./browser-capability-grants.ts";

/**
 * Preserve the canonical browser policy code at HTTP boundaries. Policy
 * refusal is deliberate and non-retryable; exposing it as a generic 500 would
 * make an operator-controlled feature gate look like a platform failure.
 */
export function toBrowserCapabilityApiError(error: unknown): ApiError | null {
  if (error instanceof BrowserCapabilityPolicyError) {
    return new ApiError({
      status: 403,
      code: "browser_policy_denied",
      title: "Browser Policy Denied",
      detail: error.message.replace(/^BROWSER_POLICY_DENIED:\s*/, ""),
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\bBROWSER_[A-Z_]+\b/)?.[0];
  const mappings: Record<string, { status: number; title: string; detail: string }> = {
    BROWSER_UNAVAILABLE: {
      status: 503,
      title: "Browser Unavailable",
      detail: "The selected backend could not provide the required browser capability.",
    },
    BROWSER_STATE_READ_FAILED: {
      status: 503,
      title: "Browser State Read Failed",
      detail:
        "The authenticated browser session was reached but its portable state could not be read.",
    },
    BROWSER_BUNDLE_UNAVAILABLE: {
      status: 503,
      title: "Browser Driver Bundle Unavailable",
      detail: "The trusted browser driver bundle could not be authorized or loaded.",
    },
    BROWSER_UNSUPPORTED_REVISION: {
      status: 422,
      title: "Browser Revision Unsupported",
      detail: "The trusted driver and browser worker protocol revisions are incompatible.",
    },
    BROWSER_POLICY_DENIED: {
      status: 403,
      title: "Browser Policy Denied",
      detail: "Browser capability policy refused this acquisition.",
    },
    BROWSER_PROXY_UNAVAILABLE: {
      status: 503,
      title: "Browser Proxy Unavailable",
      detail: "The required browser egress proxy is unavailable; direct fallback was refused.",
    },
    BROWSER_NAVIGATION_TIMEOUT: {
      status: 504,
      title: "Browser Navigation Timeout",
      detail: "The browser did not reach the expected state before the navigation deadline.",
    },
    BROWSER_CRASHED: {
      status: 503,
      title: "Browser Crashed",
      detail: "The browser worker or Chromium exited during acquisition.",
    },
    BROWSER_AUTH_REQUIRED: {
      status: 412,
      title: "Browser Authentication Required",
      detail: "The acquired browser session did not provide authenticated proof.",
    },
    BROWSER_INTERACTION_REQUIRED: {
      status: 409,
      title: "Browser Interaction Required",
      detail: "The upstream requires a user interaction before acquisition can complete.",
    },
    BROWSER_STATE_CONFLICT: {
      status: 409,
      title: "Browser State Conflict",
      detail: "The browser session state changed concurrently and was not overwritten.",
    },
    BROWSER_SESSION_BUSY: {
      status: 409,
      title: "Browser Session Busy",
      detail: "The browser-bound session is currently leased by another run.",
    },
    BROWSER_RESOURCE_LIMIT: {
      status: 429,
      title: "Browser Resource Limit",
      detail: "The configured browser worker concurrency limit has been reached.",
    },
  };
  const mapping = code ? mappings[code] : undefined;
  if (!code || !mapping) return null;
  return new ApiError({
    status: mapping.status,
    code: code.toLowerCase(),
    title: mapping.title,
    detail: mapping.detail,
  });
}
