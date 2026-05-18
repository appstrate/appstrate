// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency validation — validates that all required providers AND
 * integration connections are present (with sufficient scopes) before a run.
 * Shared by runs.ts and scheduler.ts.
 */

import { and, eq } from "drizzle-orm";
import { getConnectionStatus, type ConnectionStatus } from "./connection-manager/status.ts";
import { validateScopes } from "./connection-manager/operations.ts";
import { isProviderEnabled, getProviderCredentialId } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { integrationConnections, packages } from "@appstrate/db/schema";
import {
  parseManifestIntegrations,
  type ManifestIntegrationEntry,
} from "@appstrate/core/dependencies";
import { integrationManifestSchema, type IntegrationManifest } from "@appstrate/core/integration";
import type { AgentProviderRequirement, ProviderProfileMap } from "../types/index.ts";
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { scopesContributedByTools } from "./integration-scope-resolver.ts";

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
      deps.getConnectionStatus(
        id,
        providerProfiles[id]!.connectionProfileId,
        orgId,
        credentialById.get(id)!,
      ),
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

// ---------------------------------------------------------------------------
// Integration dependency validation
// ---------------------------------------------------------------------------

/**
 * Structured per-(integration, auth) error surfaced via `errors[]` on the
 * thrown 412. The frontend's MissingConnectionsModal parses `field` back
 * into `(packageId, authKey)` to drive its CTAs.
 */
export interface IntegrationDependencyError {
  packageId: string;
  /** `null` when the failure is integration-level (no connection on any auth). */
  authKey: string | null;
  reason:
    | "not_connected"
    | "needs_reconnection"
    | "insufficient_scopes"
    | "package_not_found"
    | "not_installed_or_invalid_manifest";
  requiredScopes?: string[];
  grantedScopes?: string[];
  missingScopes?: string[];
}

/**
 * Determine which auth keys this agent actually needs connected, given its
 * declared `tools[]` selection on the integration. Returns the full auth
 * key set when the agent didn't restrict tools (legacy / "all tools allowed"
 * semantics) — at least one of those auths must be connected. For a
 * restricted selection, returns the union of each tool's `requiredAuthKey`
 * (single-auth integrations always resolve to the lone key).
 */
function requiredAuthKeysForAgent(
  manifest: IntegrationManifest,
  agentTools: readonly string[] | undefined,
): string[] {
  const declaredAuths = manifest.auths ? Object.keys(manifest.auths) : [];
  if (declaredAuths.length === 0) return [];
  if (agentTools === undefined) return declaredAuths;
  if (declaredAuths.length === 1) return declaredAuths;

  const toolsRecord = manifest.tools ?? {};
  const out = new Set<string>();
  for (const toolName of agentTools) {
    const tool = toolsRecord[toolName];
    if (!tool || !tool.requiredAuthKey) continue;
    if (declaredAuths.includes(tool.requiredAuthKey)) out.add(tool.requiredAuthKey);
  }
  // Fallback: if the agent's tool selection didn't pin any auth (e.g. tools
  // omit `requiredAuthKey`), require every declared auth — preserves the
  // historical "any one of them" connection requirement.
  return out.size === 0 ? declaredAuths : [...out];
}

interface ConnectionRow {
  authKey: string;
  scopesGranted: string[];
  needsReconnection: boolean;
}

/**
 * Collect per-integration dependency errors as both structured records
 * (for the route handler to attach to the 412 body) AND ValidationFieldError
 * entries (so the same data flows through the standard ApiError surface).
 */
export async function collectIntegrationDependencyErrors(
  agentManifest: Record<string, unknown>,
  actor: Actor,
  scope: AppScope,
): Promise<{
  fieldErrors: ValidationFieldError[];
  integrationErrors: IntegrationDependencyError[];
}> {
  const entries = parseManifestIntegrations(agentManifest);
  if (entries.length === 0) {
    return { fieldErrors: [], integrationErrors: [] };
  }

  const fieldErrors: ValidationFieldError[] = [];
  const integrationErrors: IntegrationDependencyError[] = [];

  for (const entry of entries) {
    await checkOne(entry, actor, scope, fieldErrors, integrationErrors);
  }

  return { fieldErrors, integrationErrors };
}

async function checkOne(
  entry: ManifestIntegrationEntry,
  actor: Actor,
  scope: AppScope,
  fieldErrors: ValidationFieldError[],
  integrationErrors: IntegrationDependencyError[],
): Promise<void> {
  const push = (err: IntegrationDependencyError, title: string, message: string): void => {
    integrationErrors.push(err);
    fieldErrors.push({
      field: err.authKey
        ? `integrations.${err.packageId}.${err.authKey}`
        : `integrations.${err.packageId}`,
      code: err.reason,
      title,
      message,
    });
  };

  // Load the integration manifest fresh from DB (mirrors spawn resolver).
  const [pkgRow] = await db
    .select({
      id: packages.id,
      type: packages.type,
      manifest: packages.draftManifest,
    })
    .from(packages)
    .where(eq(packages.id, entry.id))
    .limit(1);

  if (!pkgRow || pkgRow.type !== "integration") {
    push(
      { packageId: entry.id, authKey: null, reason: "package_not_found" },
      "Integration Not Found",
      `Integration '${entry.id}' is not installed`,
    );
    return;
  }

  const parsed = integrationManifestSchema.safeParse(pkgRow.manifest);
  if (!parsed.success) {
    push(
      { packageId: entry.id, authKey: null, reason: "not_installed_or_invalid_manifest" },
      "Integration Manifest Invalid",
      `Integration '${entry.id}' manifest failed validation`,
    );
    return;
  }
  const manifest = parsed.data;
  const requiredAuthKeys = requiredAuthKeysForAgent(manifest, entry.tools);
  if (requiredAuthKeys.length === 0) {
    // Integration declares no auths — nothing to check.
    return;
  }

  // One row per (packageId, authKey) connection the actor owns in this app.
  const rows = await db
    .select({
      authKey: integrationConnections.authKey,
      scopesGranted: integrationConnections.scopesGranted,
      needsReconnection: integrationConnections.needsReconnection,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationPackageId, entry.id),
        eq(integrationConnections.applicationId, scope.applicationId),
        actorFilter(actor, {
          userId: integrationConnections.userId,
          endUserId: integrationConnections.endUserId,
        }),
      ),
    );

  // Group connections by authKey — multiple rows per auth = multiple
  // accounts. We union scopes (best-case) and OR `needsReconnection`
  // (worst-case) since any flagged account forces a re-consent.
  const byAuth = new Map<string, ConnectionRow>();
  for (const row of rows) {
    const existing = byAuth.get(row.authKey);
    if (!existing) {
      byAuth.set(row.authKey, {
        authKey: row.authKey,
        scopesGranted: [...(row.scopesGranted ?? [])],
        needsReconnection: row.needsReconnection,
      });
    } else {
      for (const s of row.scopesGranted ?? []) {
        if (!existing.scopesGranted.includes(s)) existing.scopesGranted.push(s);
      }
      existing.needsReconnection = existing.needsReconnection || row.needsReconnection;
    }
  }

  // Integration-level check: at least one required auth must have ≥1
  // connection. Mirrors the spawn resolver's "viable if any auth resolved"
  // contract.
  const connectedAuths = requiredAuthKeys.filter((k) => byAuth.has(k));
  if (connectedAuths.length === 0) {
    push(
      { packageId: entry.id, authKey: null, reason: "not_connected" },
      "Integration Not Connected",
      `Integration '${entry.id}' has no connection`,
    );
    return;
  }

  // Per-auth checks on the connected ones.
  const auths = manifest.auths ?? {};
  for (const authKey of connectedAuths) {
    const conn = byAuth.get(authKey)!;
    const auth = auths[authKey];
    if (!auth) continue; // Shouldn't happen — requiredAuthKeys is built from manifest.auths.

    if (conn.needsReconnection) {
      push(
        { packageId: entry.id, authKey, reason: "needs_reconnection" },
        "Needs Reconnection",
        `Integration '${entry.id}' (${authKey}) needs to be reconnected`,
      );
      continue;
    }

    // Scope check only applies to oauth2 — api_key / basic / custom have
    // opaque grants the IdP doesn't expose. PAT scopes on GitHub etc. are
    // checked at runtime by the upstream MCP, not here.
    if (auth.type !== "oauth2") continue;

    const requiredScopes = scopesContributedByTools({
      manifest,
      authKey,
      agentTools: entry.tools,
    });
    if (requiredScopes.length === 0) continue;

    const granted = new Set(conn.scopesGranted);
    const missing = requiredScopes.filter((s) => !granted.has(s));
    if (missing.length === 0) continue;

    push(
      {
        packageId: entry.id,
        authKey,
        reason: "insufficient_scopes",
        requiredScopes,
        grantedScopes: conn.scopesGranted,
        missingScopes: missing,
      },
      "Insufficient Scopes",
      `Integration '${entry.id}' (${authKey}) is missing scopes: ${missing.join(", ")}`,
    );
  }
}

/**
 * Validate that the actor has every connection (with sufficient scopes)
 * the agent's `dependencies.integrations` declares. Throws 412 with the
 * structured `errors[]` populated (one entry per failing (integration,
 * auth) pair) so the UI can render the MissingConnectionsModal.
 *
 * Mirrors {@link validateAgentDependencies} for the integration surface.
 * Called from the run kickoff paths (Phase A.2).
 */
export async function validateAgentIntegrations(
  agentManifest: Record<string, unknown>,
  actor: Actor,
  scope: AppScope,
): Promise<void> {
  const { fieldErrors, integrationErrors } = await collectIntegrationDependencyErrors(
    agentManifest,
    actor,
    scope,
  );
  if (fieldErrors.length === 0) return;
  const first = fieldErrors[0]!;
  throw new ApiError({
    status: 412,
    code: "missing_integration_connection",
    title: "Missing Integration Connection",
    detail: first.message,
    errors: fieldErrors,
    // Stash the structured payload on a side channel the route can read.
    // We piggyback via a non-standard `Appstrate-Missing-Integrations`
    // header carrying a base64 JSON blob. Hidden but parseable; the UI
    // primarily uses `errors[]`.
    headers: {
      "Appstrate-Missing-Integrations": Buffer.from(JSON.stringify(integrationErrors)).toString(
        "base64",
      ),
    },
  });
}
