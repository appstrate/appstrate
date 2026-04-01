/**
 * Dependency validation — validates that all required providers are connected before execution.
 * Shared by executions.ts and scheduler.ts.
 */

import { getConnectionStatus, validateScopes } from "./connection-manager/index.ts";
import type { ConnectionStatus } from "./connection-manager/index.ts";
import { isProviderEnabled } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import type { FlowProviderRequirement } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";

export interface DependencyValidationDeps {
  isProviderEnabled: (orgId: string, providerId: string) => Promise<boolean>;
  getConnectionStatus: (
    provider: string,
    connectionProfileId: string,
    orgId: string,
  ) => Promise<ConnectionStatus>;
  validateScopes: (granted: string[], required: string[]) => { sufficient: boolean };
}

const defaultDeps: DependencyValidationDeps = {
  isProviderEnabled: (orgId, providerId) => isProviderEnabled(db, orgId, providerId),
  getConnectionStatus,
  validateScopes,
};

/**
 * Validate that all required provider dependencies are satisfied.
 * providerProfiles maps providerId → connectionProfileId.
 * Throws ApiError on first unsatisfied dependency.
 */
export async function validateFlowDependencies(
  providers: FlowProviderRequirement[],
  providerProfiles: Record<string, string>,
  orgId: string,
  deps: DependencyValidationDeps = defaultDeps,
): Promise<void> {
  // Check provider enabled status
  const uniqueProviders = [...new Set(providers.map((s) => s.id))];
  for (const providerId of uniqueProviders) {
    const enabled = await deps.isProviderEnabled(orgId, providerId);
    if (!enabled) {
      throw new ApiError({
        status: 400,
        code: "provider_not_enabled",
        title: "Provider Not Enabled",
        detail: `Provider '${providerId}' is not configured`,
      });
    }
  }

  // Check for missing profiles first (no async needed)
  for (const provider of providers) {
    const connectionProfileId = providerProfiles[provider.id];
    if (!connectionProfileId) {
      throw new ApiError({
        status: 400,
        code: "dependency_not_satisfied",
        title: "Dependency Not Satisfied",
        detail: `Provider '${provider.id}' is not connected`,
      });
    }
  }

  // Fetch all connection statuses in parallel (all providers have profiles at this point)
  const statuses = await Promise.all(
    providers.map((p) => deps.getConnectionStatus(p.id, providerProfiles[p.id]!, orgId)),
  );

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    const conn = statuses[i]!;

    if (conn.status === "not_connected") {
      throw new ApiError({
        status: 400,
        code: "dependency_not_satisfied",
        title: "Dependency Not Satisfied",
        detail: `Provider '${provider.id}' is not connected`,
      });
    }

    if (conn.status === "needs_reconnection") {
      throw new ApiError({
        status: 400,
        code: "needs_reconnection",
        title: "Needs Reconnection",
        detail: `Provider '${provider.id}' needs to be reconnected (provider configuration changed)`,
      });
    }

    if (provider.scopes && provider.scopes.length > 0 && conn.scopesGranted) {
      const scopeResult = deps.validateScopes(conn.scopesGranted, provider.scopes);
      if (!scopeResult.sufficient) {
        throw new ApiError({
          status: 400,
          code: "scope_insufficient",
          title: "Scope Insufficient",
          detail: `Provider '${provider.id}' requires additional permissions`,
        });
      }
    }
  }
}
