/**
 * Token resolution — resolves service tokens for execution.
 * Shared by executions.ts, scheduler.ts, and share.ts.
 */

import { getCredentials, getProvider } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import { computeConfigHash } from "./connection-profiles.ts";
import type { FlowServiceRequirement } from "../types/index.ts";

/**
 * Build a map of service tokens for all required services.
 * serviceProfiles maps serviceId → profileId.
 * Uses orgId to resolve the correct configHash per provider.
 */
export async function buildServiceTokens(
  services: FlowServiceRequirement[],
  serviceProfiles: Record<string, string>,
  orgId: string,
): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};

  for (const svc of services) {
    const profileId = serviceProfiles[svc.id];

    if (profileId) {
      // Resolve configHash for this org's provider config
      const providerDef = await getProvider(db, orgId, svc.provider);
      const configHash = providerDef ? computeConfigHash(providerDef) : undefined;

      const result = await getCredentials(db, profileId, svc.provider, configHash);
      let token = result
        ? (result.credentials.access_token ?? result.credentials.api_key ?? null)
        : null;
      // Fallback: if credentials exist but no standard field, mark as connected
      // so the service appears in the prompt and CONNECTED_SERVICES
      if (!token && result && Object.keys(result.credentials).length > 0) {
        token = "__connected__";
      }
      if (token) {
        tokens[svc.id] = token;
      } else {
        logger.warn("No token resolved for service", {
          serviceId: svc.id,
          provider: svc.provider,
          profileId,
        });
      }
    }
  }

  return tokens;
}
