/**
 * Token resolution — resolves service tokens for execution.
 * Shared by executions.ts, scheduler.ts, and share.ts.
 */

import { getCredentials } from "@appstrate/connect";
import { supabase } from "../lib/supabase.ts";
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
      const result = await getCredentials(supabase, orgId, tokenUserId, svc.provider);
      const token = result
        ? (result.credentials.access_token ?? result.credentials.api_key ?? null)
        : null;
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
