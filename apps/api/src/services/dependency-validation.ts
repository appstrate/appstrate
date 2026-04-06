// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency validation — validates that all required providers are connected before a run.
 * Shared by runs.ts and scheduler.ts.
 */

import { getConnectionStatus, validateScopes } from "./connection-manager/index.ts";
import type { ConnectionStatus } from "./connection-manager/index.ts";
import { isProviderEnabled, getProviderCredentialId } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import type { AgentProviderRequirement, ProviderProfileMap } from "../types/index.ts";
import { ApiError } from "../lib/errors.ts";

export interface DependencyValidationDeps {
  isProviderEnabled: (providerId: string, applicationId: string) => Promise<boolean>;
  getConnectionStatus: (
    provider: string,
    connectionProfileId: string,
    orgId: string,
    providerCredentialId: string,
  ) => Promise<ConnectionStatus>;
  getProviderCredentialId: (applicationId: string, providerId: string) => Promise<string | null>;
  validateScopes: (
    granted: string[],
    required: string[],
  ) => { sufficient: boolean; missing: string[] };
}

const defaultDeps: DependencyValidationDeps = {
  isProviderEnabled: (providerId, applicationId) =>
    isProviderEnabled(db, providerId, applicationId),
  getConnectionStatus,
  getProviderCredentialId: (applicationId, providerId) =>
    getProviderCredentialId(db, applicationId, providerId),
  validateScopes,
};

/**
 * Validate that all required provider dependencies are satisfied.
 * providerProfiles maps providerId → connectionProfileId.
 * Throws ApiError on first unsatisfied dependency.
 */
export async function validateAgentDependencies(
  providers: AgentProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
  applicationId: string,
  deps: DependencyValidationDeps = defaultDeps,
): Promise<void> {
  // Check provider enabled status
  const uniqueProviders = [...new Set(providers.map((s) => s.id))];
  for (const providerId of uniqueProviders) {
    const enabled = await deps.isProviderEnabled(providerId, applicationId);
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
    const entry = providerProfiles[provider.id];
    if (!entry) {
      throw new ApiError({
        status: 400,
        code: "dependency_not_satisfied",
        title: "Dependency Not Satisfied",
        detail: `Provider '${provider.id}' is not connected`,
      });
    }
  }

  // Resolve providerCredentialIds and fetch connection statuses in parallel
  const credentialIds = await Promise.all(
    providers.map((p) => deps.getProviderCredentialId(applicationId, p.id)),
  );

  const statuses = await Promise.all(
    providers.map((p, i) => {
      const credentialId = credentialIds[i];
      if (!credentialId) {
        // No credential configured for this provider in this app — treat as not connected
        return Promise.resolve({
          provider: p.id,
          status: "not_connected" as const,
        } as ConnectionStatus);
      }
      return deps.getConnectionStatus(p.id, providerProfiles[p.id]!.profileId, orgId, credentialId);
    }),
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
          detail: `Provider '${provider.id}' requires additional permissions: ${scopeResult.missing.join(", ")}`,
        });
      }
    }
  }
}
