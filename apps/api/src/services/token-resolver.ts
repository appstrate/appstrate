/**
 * Token resolution — resolves provider tokens for execution.
 * Shared by executions.ts, scheduler.ts, and share.ts.
 */

import { getCredentials } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { FlowProviderRequirement } from "../types/index.ts";

/**
 * Sentinel value for providers that have credentials but no standard token field
 * (e.g. basic or custom auth modes). Downstream consumers only check token
 * existence in the map — the value itself is never forwarded to containers.
 */
const CONNECTED_SENTINEL = "__connected__";

/**
 * Build a map of provider tokens for all required providers.
 * providerProfiles maps providerId → profileId.
 *
 * For providers with `access_token` or `api_key` credentials, the actual token
 * value is stored. For other auth modes (basic, custom) that have credentials,
 * a sentinel value is used so downstream filters correctly identify the provider
 * as connected.
 */
export async function buildProviderTokens(
  providers: FlowProviderRequirement[],
  providerProfiles: Record<string, string>,
  orgId: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    providers
      .filter((svc) => providerProfiles[svc.id])
      .map(async (svc) => {
        const profileId = providerProfiles[svc.id]!;

        const result = await getCredentials(db, profileId, svc.id, orgId);
        const token = result
          ? (result.credentials.access_token ??
            result.credentials.api_key ??
            (Object.keys(result.credentials).length > 0 ? CONNECTED_SENTINEL : null))
          : null;
        if (!token) {
          logger.warn("No token resolved for provider", {
            providerId: svc.id,
            provider: svc.provider,
            profileId,
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
