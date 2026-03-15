/**
 * Dependency validation — validates that all required providers are connected before execution.
 * Shared by executions.ts, share.ts, and scheduler.ts.
 */

import { getConnectionStatus, validateScopes } from "./connection-manager.ts";
import { isProviderEnabled } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import type { FlowProviderRequirement } from "../types/index.ts";

export interface DependencyError {
  error: string;
  message: string;
  providerId: string;
  connectUrl?: string;
  details?: Record<string, unknown>;
}

/**
 * Validate that all required provider dependencies are satisfied.
 * providerProfiles maps providerId → profileId.
 * Returns null if all deps are OK, or a DependencyError describing the first failure.
 */
export async function validateFlowDependencies(
  providers: FlowProviderRequirement[],
  providerProfiles: Record<string, string>,
  orgId: string,
): Promise<DependencyError | null> {
  // Check provider enabled status
  const uniqueProviders = [...new Set(providers.map((s) => s.provider))];
  for (const providerId of uniqueProviders) {
    const enabled = await isProviderEnabled(db, orgId, providerId);
    if (!enabled) {
      return {
        error: "PROVIDER_NOT_ENABLED",
        message: `Provider '${providerId}' is not configured`,
        providerId: providers.find((s) => s.provider === providerId)!.id,
      };
    }
  }

  // Check for missing profiles first (no async needed)
  for (const svc of providers) {
    const profileId = providerProfiles[svc.id];
    if (!profileId) {
      const mode = svc.connectionMode ?? "user";
      if (mode === "admin") {
        return {
          error: "DEPENDENCY_NOT_SATISFIED",
          message: `Provider '${svc.id}' is not bound by an administrator`,
          providerId: svc.id,
        };
      }
      return {
        error: "DEPENDENCY_NOT_SATISFIED",
        message: `Provider '${svc.id}' is not connected`,
        providerId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }
  }

  // Fetch all connection statuses in parallel (all providers have profiles at this point)
  const statuses = await Promise.all(
    providers.map((svc) => getConnectionStatus(svc.provider, providerProfiles[svc.id]!, orgId)),
  );

  for (let i = 0; i < providers.length; i++) {
    const svc = providers[i]!;
    const conn = statuses[i]!;

    if (conn.status === "not_connected") {
      return {
        error: "DEPENDENCY_NOT_SATISFIED",
        message: `Provider '${svc.id}' is not connected`,
        providerId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }

    if (conn.status === "needs_reconnection") {
      return {
        error: "NEEDS_RECONNECTION",
        message: `Provider '${svc.id}' needs to be reconnected (provider configuration changed)`,
        providerId: svc.id,
        connectUrl: `/auth/connect/${svc.provider}`,
      };
    }

    if (svc.scopes && svc.scopes.length > 0 && conn.scopesGranted) {
      const scopeResult = validateScopes(conn.scopesGranted, svc.scopes);
      if (!scopeResult.sufficient) {
        return {
          error: "SCOPE_INSUFFICIENT",
          message: `Provider '${svc.id}' requires additional permissions`,
          providerId: svc.id,
          details: {
            providerId: svc.id,
            provider: svc.provider,
            missing: scopeResult.missing,
            granted: scopeResult.granted,
          },
        };
      }
    }
  }

  return null;
}
