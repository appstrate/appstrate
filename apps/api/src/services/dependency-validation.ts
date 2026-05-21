// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency validation — validates that all required integration connections
 * are present (with sufficient scopes) before a run. Shared by runs.ts and
 * scheduler.ts.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import {
  parseManifestIntegrations,
  type ManifestIntegrationEntry,
} from "@appstrate/core/dependencies";
import { type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import {
  expandGrantedScopes,
  requiredAuthKeysForAgent,
  scopesContributedByTools,
} from "@appstrate/core/integration";
import { fetchIntegrationManifest } from "./integration-service.ts";

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
    // Smuggle requiredScopes on the field entry for `insufficient_scopes`
    // — the dashboard's InlineConnectButton forwards it to the OAuth
    // kickoff so the consent prompt asks for the strict superset of
    // what's currently granted + what THIS agent needs. The backend
    // re-unions with computeRequiredScopes(all agents) before issuing
    // the redirect, so this is just a hint that gets the right
    // single-agent floor on the request.
    fieldErrors.push({
      field: err.authKey
        ? `integrations.${err.packageId}.${err.authKey}`
        : `integrations.${err.packageId}`,
      code: err.reason,
      title,
      message,
      ...(err.requiredScopes && err.requiredScopes.length > 0
        ? { requiredScopes: err.requiredScopes }
        : {}),
    } as ValidationFieldError);
  };

  // Load the integration manifest fresh from DB (mirrors spawn resolver).
  const res = await fetchIntegrationManifest(entry.id);
  if (!res.ok) {
    if (res.failure.kind === "invalid_manifest") {
      push(
        { packageId: entry.id, authKey: null, reason: "not_installed_or_invalid_manifest" },
        "Integration Manifest Invalid",
        `Integration '${entry.id}' manifest failed validation`,
      );
    } else {
      // not_found or not_integration — both surface as "not installed"
      // to keep the error envelope stable across the two cases.
      push(
        { packageId: entry.id, authKey: null, reason: "package_not_found" },
        "Integration Not Found",
        `Integration '${entry.id}' is not installed`,
      );
    }
    return;
  }
  const manifest = res.manifest;
  const requiredAuthKeys = requiredAuthKeysForAgent(manifest, entry.tools);
  if (requiredAuthKeys.length === 0) {
    // No auth required — either the integration declares none, or the
    // agent picked 0 tools (niveau 2: dep declared but inert, no
    // connection gate at run-kickoff).
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

    // Expand granted through the manifest's `availableScopes.implies`
    // hierarchy — e.g. GitHub's `repo` implies `public_repo`, so a
    // connection granted `repo` is not missing `public_repo`.
    const granted = new Set(expandGrantedScopes(conn.scopesGranted, manifest, authKey));
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
