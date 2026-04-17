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
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";

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
 * Collect every unsatisfied-dependency error as structured field entries.
 * Used by accumulate-mode preflight to surface multiple providers' issues in
 * one response. The throwing variant below delegates here and raises the first.
 */
export async function collectDependencyErrors(
  providers: AgentProviderRequirement[],
  providerProfiles: ProviderProfileMap,
  orgId: string,
  applicationId: string,
  deps: DependencyValidationDeps = defaultDeps,
): Promise<ValidationFieldError[]> {
  const errors: ValidationFieldError[] = [];

  // Check provider enabled status
  const uniqueProviders = [...new Set(providers.map((s) => s.id))];
  const enabledChecks = await Promise.all(
    uniqueProviders.map((id) => deps.isProviderEnabled(id, applicationId)),
  );
  const disabled = new Set<string>();
  for (let i = 0; i < uniqueProviders.length; i++) {
    if (!enabledChecks[i]) {
      const id = uniqueProviders[i]!;
      disabled.add(id);
      errors.push({
        field: `providers.${id}`,
        code: "provider_not_enabled",
        message: `Provider '${id}' is not configured`,
      });
    }
  }

  // Missing profiles
  const missingProfile = new Set<string>();
  for (const provider of providers) {
    if (disabled.has(provider.id)) continue;
    if (!providerProfiles[provider.id]) {
      missingProfile.add(provider.id);
      errors.push({
        field: `providers.${provider.id}`,
        code: "dependency_not_satisfied",
        message: `Provider '${provider.id}' is not connected`,
      });
    }
  }

  // Credential ids — only for providers that passed the two checks above
  const checkable = providers.filter((p) => !disabled.has(p.id) && !missingProfile.has(p.id));
  const credentialIds = await Promise.all(
    checkable.map((p) => deps.getProviderCredentialId(applicationId, p.id)),
  );
  const withCredentials: Array<{ provider: AgentProviderRequirement; credentialId: string }> = [];
  for (let i = 0; i < checkable.length; i++) {
    const provider = checkable[i]!;
    const credentialId = credentialIds[i];
    if (!credentialId) {
      errors.push({
        field: `providers.${provider.id}`,
        code: "provider_not_configured",
        message: `Provider '${provider.id}' is no longer configured for this application`,
      });
    } else {
      withCredentials.push({ provider, credentialId });
    }
  }

  const statuses = await Promise.all(
    withCredentials.map(({ provider, credentialId }) =>
      deps.getConnectionStatus(
        provider.id,
        providerProfiles[provider.id]!.profileId,
        orgId,
        credentialId,
      ),
    ),
  );

  for (let i = 0; i < withCredentials.length; i++) {
    const provider = withCredentials[i]!.provider;
    const conn = statuses[i]!;

    if (conn.status === "not_connected") {
      errors.push({
        field: `providers.${provider.id}`,
        code: "dependency_not_satisfied",
        message: `Provider '${provider.id}' is not connected`,
      });
      continue;
    }

    if (conn.status === "needs_reconnection") {
      errors.push({
        field: `providers.${provider.id}`,
        code: "needs_reconnection",
        message: `Provider '${provider.id}' needs to be reconnected (provider configuration changed)`,
      });
      continue;
    }

    if (provider.scopes && provider.scopes.length > 0 && conn.scopesGranted) {
      const scopeResult = deps.validateScopes(conn.scopesGranted, provider.scopes);
      if (!scopeResult.sufficient) {
        errors.push({
          field: `providers.${provider.id}`,
          code: "scope_insufficient",
          message: `Provider '${provider.id}' requires additional permissions: ${scopeResult.missing.join(", ")}`,
        });
      }
    }
  }

  return errors;
}

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
  const errors = await collectDependencyErrors(
    providers,
    providerProfiles,
    orgId,
    applicationId,
    deps,
  );
  if (errors.length === 0) return;
  const first = errors[0]!;
  throw new ApiError({
    status: 400,
    code: first.code,
    title: first.code,
    detail: first.message,
  });
}
