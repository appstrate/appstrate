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
 */
export async function buildServiceTokens(
  services: FlowServiceRequirement[],
  adminConns: Record<string, string>,
  orgId: string,
  userId: string,
): Promise<Record<string, string>> {
  const tokens: Record<string, string> = {};

  for (const svc of services) {
    const mode = svc.connectionMode ?? "user";
    const tokenUserId = mode === "admin" ? adminConns[svc.id] : userId;

    if (tokenUserId) {
      const result = await getCredentials(db, orgId, tokenUserId, svc.provider);
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
          userId: tokenUserId,
        });
      }
    }
  }

  return tokens;
}
