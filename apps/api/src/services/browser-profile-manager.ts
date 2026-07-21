// SPDX-License-Identifier: Apache-2.0

import type { BrowserProviderId } from "@appstrate/core/sidecar-types";
import { getEnv } from "@appstrate/env";

const BROWSER_USE_PROFILES_API = "https://api.browser-use.com/api/v2/profiles";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BrowserProfileManager {
  allocate(input: {
    provider: BrowserProviderId;
    attemptId: string;
    actorRef: string;
  }): Promise<string>;
  remove(provider: BrowserProviderId, profileRef: string): Promise<void>;
}

export class BrowserProfileProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProfileProviderError";
  }
}

function boundedProviderLabel(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, "-");
  return normalized.slice(0, 100) || "appstrate-browser";
}

export function createBrowserProfileManager(
  deps: { fetchFn?: typeof fetch; apiKey?: string } = {},
): BrowserProfileManager {
  const fetchFn = deps.fetchFn ?? fetch;
  const apiKey = deps.apiKey ?? getEnv().BROWSER_USE_API_KEY;

  return {
    async allocate({ provider, attemptId, actorRef }) {
      if (provider === "process") return attemptId;
      if (!apiKey || apiKey.length < 16) {
        throw new BrowserProfileProviderError("Browser Use Cloud is not configured");
      }
      const response = await fetchFn(BROWSER_USE_PROFILES_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Browser-Use-API-Key": apiKey,
        },
        body: JSON.stringify({
          name: boundedProviderLabel(`appstrate-${attemptId}`),
          // Browser Use documents this as the caller's internal identifier.
          // Use an opaque actor reference rather than an email/login.
          userId: boundedProviderLabel(actorRef).slice(0, 255),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status !== 201) {
        throw new BrowserProfileProviderError(
          `Browser Use profile allocation returned ${response.status}`,
        );
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
        throw new BrowserProfileProviderError("Browser Use returned a malformed profile id");
      }
      return body.id;
    },

    async remove(provider, profileRef) {
      if (provider === "process") return;
      if (!apiKey || apiKey.length < 16) {
        throw new BrowserProfileProviderError("Browser Use Cloud is not configured");
      }
      if (!UUID_PATTERN.test(profileRef)) {
        throw new BrowserProfileProviderError("Browser Use profile id is malformed");
      }
      const response = await fetchFn(
        `${BROWSER_USE_PROFILES_API}/${encodeURIComponent(profileRef)}`,
        {
          method: "DELETE",
          headers: { "X-Browser-Use-API-Key": apiKey },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new BrowserProfileProviderError(
          `Browser Use profile deletion returned ${response.status}`,
        );
      }
    },
  };
}
