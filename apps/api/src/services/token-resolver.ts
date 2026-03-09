/**
 * Token resolution — resolves provider tokens for execution.
 * Shared by executions.ts, scheduler.ts, and share.ts.
 */

import { getCredentials } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { FlowProviderRequirement } from "../types/index.ts";

/**
 * Build a map of provider tokens for all required providers.
 * providerProfiles maps providerId → profileId.
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

        const result = await getCredentials(db, profileId, svc.provider, orgId);
        let token = result
          ? (result.credentials.access_token ?? result.credentials.api_key ?? null)
          : null;
        // Fallback: credentials exist but no standard field — mark as connected
        // so the provider appears in the prompt and CONNECTED_PROVIDERS
        if (!token && result && Object.keys(result.credentials).length > 0) {
          token = "__connected__";
        }
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
