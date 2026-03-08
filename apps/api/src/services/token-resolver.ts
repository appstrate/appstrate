/**
 * Token resolution — resolves service tokens for execution.
 * Shared by executions.ts, scheduler.ts, and share.ts.
 */

import { getCredentials } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { FlowServiceRequirement } from "../types/index.ts";

/**
 * Build a map of service tokens for all required services.
 * serviceProfiles maps serviceId → profileId.
 */
export async function buildServiceTokens(
  services: FlowServiceRequirement[],
  serviceProfiles: Record<string, string>,
  orgId: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    services
      .filter((svc) => serviceProfiles[svc.id])
      .map(async (svc) => {
        const profileId = serviceProfiles[svc.id]!;

        const result = await getCredentials(db, profileId, svc.provider, orgId);
        let token = result
          ? (result.credentials.access_token ?? result.credentials.api_key ?? null)
          : null;
        // Fallback: credentials exist but no standard field — mark as connected
        // so the service appears in the prompt and CONNECTED_SERVICES
        if (!token && result && Object.keys(result.credentials).length > 0) {
          token = "__connected__";
        }
        if (!token) {
          logger.warn("No token resolved for service", {
            serviceId: svc.id,
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
