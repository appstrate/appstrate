// SPDX-License-Identifier: Apache-2.0

/**
 * Token resolution — resolves provider tokens for execution.
 * Shared by runs.ts and scheduler.ts.
 */

import { getCredentials } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { logger } from "../lib/logger.ts";
import type { AgentProviderRequirement, ProviderProfileMap } from "../types/index.ts";

/**
 * Sentinel value for providers that have credentials but no standard token field
 * (e.g. basic or custom auth modes). Downstream consumers only check token
 * existence in the map — the value itself is never forwarded to containers.
 */
const CONNECTED_SENTINEL = "__connected__";

/**
 * Build a map of provider tokens for all required providers.
 * providerProfiles maps providerId → connectionProfileId.
 *
 * For providers with `access_token` or `api_key` credentials, the actual token
 * value is stored. For other auth modes (basic, custom) that have credentials,
 * a sentinel value is used so downstream filters correctly identify the provider
 * as connected.
 */
export async function buildProviderTokens(
  providers: AgentProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    providers
      .filter((svc) => providerProfiles[svc.id])
      .map(async (svc) => {
        const entry = providerProfiles[svc.id];
        if (!entry) return [svc.id, null] as const;
        const connectionProfileId = entry.profileId;

        const result = await getCredentials(db, connectionProfileId, svc.id, orgId);
        const token = result
          ? (result.credentials.access_token ??
            result.credentials.api_key ??
            (Object.keys(result.credentials).length > 0 ? CONNECTED_SENTINEL : null))
          : null;
        if (!token) {
          logger.warn("No token resolved for provider", {
            providerId: svc.id,
            connectionProfileId,
          });
        }
        return [svc.id, token] as const;
      }),
  );

  const tokens: Record<string, string> = {};
  for (const [id, token] of entries) {
    if (token) tokens[id] = token;
  }
  return tokens;
}
