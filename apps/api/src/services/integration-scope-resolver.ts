// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 — OAuth scope inference for integration connect flows.
 *
 * `computeRequiredScopes` walks every agent installed in the application,
 * reads its `integrations_configuration[id]` selection (§4.4), and
 * unions the scopes contributed by each:
 *
 *   - `tools[]` declared by the agent → look up
 *     `integration.tools_policy[t].required_scopes[authKey]` (the per-auth map)
 *     and union them.
 *   - `scopes[]` declared by the agent → unioned as-is.
 *   - Agent declared the integration with no `integrations_configuration`
 *     entry (or one without `tools[]`) → contribute the union of *every*
 *     declared tool's `required_scopes` for this auth (= "all tools
 *     allowed" default that mirrors Phase 3's runtime allowlist
 *     semantics).
 *
 * This is the floor every installed agent needs. It is NOT injected into
 * the connect kickoff — connecting requests the manifest defaults (plus
 * whatever the caller explicitly forwards), so a plain "connect" never
 * inherits unrelated agents' scopes. The union is consumed at refresh time
 * (`integration-credentials-resolver`) to detect when an IdP-side scope
 * shrink drops a connection below what the installed agents require, and
 * the agent surface uses the per-agent slice to drive an explicit upgrade.
 *
 * `getCurrentScopesGranted` reads the `scopesGranted` of one connection row
 * (the one being reconnected/upgraded) so the kickoff can keep re-consent a
 * strict superset of what that account already authorized.
 *
 * Both functions are read-only and safe to call from non-mutating routes.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, integrationConnections, packages } from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { requiredScopesForAgent } from "@appstrate/core/integration";

import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { getIntegration } from "./integration-service.ts";

export interface ComputeRequiredScopesResult {
  /** Union over all agents — the set to add to the IdP authorize request. */
  required: string[];
}

export interface ScopeResolverInput {
  scope: AppScope;
  integrationId: string;
  /** Auth key on the integration manifest — selects the `required_scopes[authKey]` slice. */
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
  const integration = await getIntegration(input.scope.orgId, input.integrationId);
  if (!integration) {
    return { required: [] };
  }

  // Resolve the auth this kickoff is for. Unknown auth key = nothing to
  // contribute (the kickoff route guards earlier, but be defensive).
  if (!integration.manifest.auths || !integration.manifest.auths[input.authKey]) {
    return { required: [] };
  }

  // Walk installed agents. We need the manifest of each to read its
  // `integrations_configuration`; that lives on `draftManifest`, same
  // column the runtime resolver reads at spawn time.
  const installed = await db
    .select({ draftManifest: packages.draftManifest })
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, input.scope.applicationId),
        eq(packages.type, "agent"),
      ),
    );

  const required = new Set<string>();

  for (const agent of installed) {
    if (!agent.draftManifest || typeof agent.draftManifest !== "object") continue;
    const integEntries = parseManifestIntegrations(agent.draftManifest as Record<string, unknown>);
    const entry = integEntries.find((e) => e.id === input.integrationId);
    if (!entry) continue;

    // AFPS §4.4 wildcard — when the agent set `tools: "*"`, scopes fall
    // back to the auth's `default_scopes` (§7.4) instead of the per-tool
    // union. Otherwise:
    //   entry.tools = undefined → no integrations_configuration entry (or
    //                             one without `tools`) → "no tools used".
    //   entry.tools = [] (explicit empty array) → "no tools used" — agents
    //                             that configured zero tools also want zero
    //                             inferred scopes.
    for (const s of requiredScopesForAgent({
      manifest: integration.manifest,
      authKey: input.authKey,
      agentTools: entry.tools,
      agentScopes: entry.scopes,
    }))
      required.add(s);
  }

  return { required: [...required] };
}

/**
 * `scopesGranted` of a single connection row the actor owns — the row
 * being reconnected/upgraded, keyed by `connectionId`. The kickoff route
 * unions this into the re-consent request so an upgrade never silently
 * shrinks what that specific account already authorized (incremental
 * consent is per-account). A fresh connect has no `connectionId` and the
 * route skips this entirely, so it stays at the manifest default scopes.
 *
 * Actor-filtered for safety — a caller can't read another actor's granted
 * scopes by guessing a connection id.
 */
export async function getCurrentScopesGranted(input: {
  scope: AppScope;
  integrationId: string;
  authKey: string;
  actor: Actor;
  connectionId: string;
}): Promise<string[]> {
  const rows = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, input.connectionId),
        eq(integrationConnections.integrationId, input.integrationId),
        eq(integrationConnections.authKey, input.authKey),
        eq(integrationConnections.applicationId, input.scope.applicationId),
        actorFilter(input.actor, {
          userId: integrationConnections.userId,
          endUserId: integrationConnections.endUserId,
        }),
      ),
    );
  return rows[0]?.scopesGranted ?? [];
}
