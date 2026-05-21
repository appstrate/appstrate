// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 — dynamic OAuth scope computation for integration connect flows.
 *
 * The OAuth kickoff (`POST /api/integrations/.../connect/oauth2`) used
 * to request `auth.scopes` defaults + the caller-supplied `body.scopes`.
 * Niveau 2 widens that to:
 *
 *   request = defaults
 *           ∪ caller-supplied
 *           ∪ inferred-from-installed-agents (this module)
 *           ∪ currently-granted (high-water-mark, incremental consent)
 *
 * `computeRequiredScopes` walks every agent installed in the application,
 * reads its `dependencies.integrations[id]` rich-form selection, and
 * unions the scopes contributed by each:
 *
 *   - `tools[]` declared by the agent → look up
 *     `integration.tools[t].requiredScopes` (filtered by `requiredAuthKey`
 *     when multi-auth) and union them.
 *   - `scopes[]` declared by the agent → unioned as-is.
 *   - Agent declared the integration as a bare semver-range string (or
 *     rich form without `tools[]`) → contribute the union of *every*
 *     declared tool's `requiredScopes` for this auth (= "all tools
 *     allowed" default that mirrors Phase 3's runtime allowlist
 *     semantics).
 *
 * `getCurrentGrantedScopes` reads the high-water-mark across every row in
 * `integration_connections` matching `(app, integration, authKey, actor)`
 * — typically one row per Google/etc. account the actor connected. We
 * union across accounts so the re-consent prompt requests the strict
 * superset, regardless of which account the user picks at the IdP.
 *
 * Both functions are read-only and safe to call from non-mutating
 * routes (e.g. the `/required-scopes` debug endpoint).
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, integrationConnections, packages } from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { scopesContributedByTools } from "@appstrate/core/integration";

import type { ScopeBreakdownEntry } from "@appstrate/shared-types";

import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { getIntegration } from "./integration-service.ts";

export type { ScopeBreakdownEntry };

export interface ComputeRequiredScopesResult {
  /** Union over all agents — the set to add to the IdP authorize request. */
  required: string[];
  /** Per-agent decomposition. Empty when no installed agent depends on this integration. */
  breakdown: ScopeBreakdownEntry[];
}

export interface ScopeResolverInput {
  scope: AppScope;
  integrationPackageId: string;
  /** Auth key on the integration manifest — drives `requiredAuthKey` filtering. */
  authKey: string;
}

/**
 * Compute the OAuth scope set required by every agent installed in the
 * application that depends on this integration's auth. Returns an empty
 * `required` array when no installed agent uses the integration (callers
 * should fall back to the manifest defaults).
 *
 * Resolves the integration manifest fresh from DB on every call — cheap
 * (one row lookup + JSON parse) and avoids a stale cache hiding scope
 * additions made after the app booted.
 */
export async function computeRequiredScopes(
  input: ScopeResolverInput,
): Promise<ComputeRequiredScopesResult> {
  const integration = await getIntegration(input.scope.orgId, input.integrationPackageId);
  if (!integration) {
    return { required: [], breakdown: [] };
  }

  // Resolve the auth this kickoff is for. Unknown auth key = nothing to
  // contribute (the kickoff route guards earlier, but be defensive).
  if (!integration.manifest.auths || !integration.manifest.auths[input.authKey]) {
    return { required: [], breakdown: [] };
  }

  // Walk installed agents. We need the manifest of each to read its
  // `dependencies.integrations` rich form; that lives on `draftManifest`,
  // same column the runtime resolver reads at spawn time.
  const installed = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, input.scope.applicationId),
        eq(packages.type, "agent"),
      ),
    );

  const breakdown: ScopeBreakdownEntry[] = [];
  const required = new Set<string>();

  for (const agent of installed) {
    if (!agent.draftManifest || typeof agent.draftManifest !== "object") continue;
    const integEntries = parseManifestIntegrations(agent.draftManifest as Record<string, unknown>);
    const entry = integEntries.find((e) => e.id === input.integrationPackageId);
    if (!entry) continue;

    const viaTools = scopesContributedByTools({
      manifest: integration.manifest,
      authKey: input.authKey,
      // entry.tools = undefined → "all tools allowed" default (bare
      // semver-range deps + rich form without `tools`). entry.tools =
      // [] (explicit empty array) is treated as "no tools used" —
      // agents that opted into the rich form but want zero tools also
      // want zero inferred scopes.
      agentTools: entry.tools,
    });
    const viaExplicit = entry.scopes ? [...entry.scopes] : [];

    if (viaTools.length === 0 && viaExplicit.length === 0) continue;

    breakdown.push({ agentId: agent.id, viaTools, viaExplicit });
    for (const s of viaTools) required.add(s);
    for (const s of viaExplicit) required.add(s);
  }

  return { required: [...required], breakdown };
}

/**
 * Union of `scopesGranted` across every connection row the actor owns
 * for this (integration, authKey) — typically one row per IdP account.
 * Empty when the actor has never connected. Used by the kickoff route
 * to keep the re-consent prompt strict-superset of what's already
 * granted (incremental consent semantics).
 */
export async function getCurrentGrantedScopes(input: {
  scope: AppScope;
  integrationPackageId: string;
  authKey: string;
  actor: Actor;
}): Promise<string[]> {
  const rows = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationPackageId, input.integrationPackageId),
        eq(integrationConnections.authKey, input.authKey),
        eq(integrationConnections.applicationId, input.scope.applicationId),
        actorFilter(input.actor, {
          userId: integrationConnections.userId,
          endUserId: integrationConnections.endUserId,
        }),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    for (const s of r.scopesGranted ?? []) out.add(s);
  }
  return [...out];
}
