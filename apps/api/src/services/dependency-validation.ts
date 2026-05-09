// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency validation — validates that all required providers are connected before a run.
 * Shared by runs.ts and scheduler.ts.
 */

import { getConnectionStatus, type ConnectionStatus } from "./connection-manager/status.ts";
import { validateScopes } from "./connection-manager/operations.ts";
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
  getConnectionStatus: (provider, connectionProfileId, orgId, providerCredentialId) =>
    getConnectionStatus({ orgId }, provider, connectionProfileId, providerCredentialId),
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

  // Check provider enabled status. Deduplicate by id so we run one query per
  // distinct provider and avoid emitting the same error twice when a provider
  // is declared with multiple scope sets in the same manifest.
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
        title: "Provider Not Enabled",
        message: `Provider '${id}' is not configured`,
      });
    }
  }

  // Missing profiles — iterate unique ids so duplicated requirements don't
  // produce duplicate entries for the same provider.
  const missingProfile = new Set<string>();
  for (const id of uniqueProviders) {
    if (disabled.has(id)) continue;
    if (!providerProfiles[id]) {
      missingProfile.add(id);
      errors.push({
        field: `providers.${id}`,
        code: "dependency_not_satisfied",
        title: "Dependency Not Satisfied",
        message: `Provider '${id}' is not connected`,
      });
    }
  }

  // Credential ids — only for providers that passed the two checks above.
  // One lookup per unique provider; scope checks below still iterate the
  // full `providers` list to validate each declared scope set.
  const checkableIds = uniqueProviders.filter((id) => !disabled.has(id) && !missingProfile.has(id));
  const credentialIds = await Promise.all(
    checkableIds.map((id) => deps.getProviderCredentialId(applicationId, id)),
  );
  const credentialById = new Map<string, string>();
  for (let i = 0; i < checkableIds.length; i++) {
    const id = checkableIds[i]!;
    const credentialId = credentialIds[i];
    if (!credentialId) {
      errors.push({
        field: `providers.${id}`,
        code: "provider_not_configured",
        title: "Provider Not Configured",
        message: `Provider '${id}' is no longer configured for this application`,
      });
    } else {
      credentialById.set(id, credentialId);
    }
  }

  // Status lookup is per-provider, but scope validation is per-requirement
  // (a provider may be declared with several scope sets).
  const statusIds = [...credentialById.keys()];
  const statuses = await Promise.all(
    statusIds.map((id) =>
      deps.getConnectionStatus(id, providerProfiles[id]!.profileId, orgId, credentialById.get(id)!),
    ),
  );
  const statusById = new Map(statusIds.map((id, i) => [id, statuses[i]!] as const));

  const statusErrorEmitted = new Set<string>();
  for (const provider of providers) {
    const conn = statusById.get(provider.id);
    if (!conn) continue;

    if (conn.status === "not_connected") {
      if (!statusErrorEmitted.has(provider.id)) {
        statusErrorEmitted.add(provider.id);
        errors.push({
          field: `providers.${provider.id}`,
          code: "dependency_not_satisfied",
          title: "Dependency Not Satisfied",
          message: `Provider '${provider.id}' is not connected`,
        });
      }
      continue;
    }

    if (conn.status === "needs_reconnection") {
      if (!statusErrorEmitted.has(provider.id)) {
        statusErrorEmitted.add(provider.id);
        errors.push({
          field: `providers.${provider.id}`,
          code: "needs_reconnection",
          title: "Needs Reconnection",
          message: `Provider '${provider.id}' needs to be reconnected (provider configuration changed)`,
        });
      }
      continue;
    }

    if (provider.scopes && provider.scopes.length > 0 && conn.scopesGranted) {
      const scopeResult = deps.validateScopes(conn.scopesGranted, provider.scopes);
      if (!scopeResult.sufficient) {
        errors.push({
          field: `providers.${provider.id}`,
          code: "scope_insufficient",
          title: "Scope Insufficient",
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
 * Throws ApiError on first unsatisfied dependency, preserving the
 * historical human-readable title (carried on each field entry).
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
    title: first.title ?? first.code,
    detail: first.message,
  });
}
