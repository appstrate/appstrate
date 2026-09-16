// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 — OAuth scope inference for integration connect flows.
 *
 * `computeRequiredScopes` walks every agent the space ACTIVELY runs,
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
 * This is the floor every active agent needs. It is NOT injected into
 * the connect kickoff — connecting requests the manifest defaults (plus
 * whatever the caller explicitly forwards), so a plain "connect" never
 * inherits unrelated agents' scopes. The union is consumed at refresh time
 * (`integration-credentials-resolver`) to detect when an IdP-side scope
 * shrink drops a connection below what the active agents require, and
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
import {
  spacePackages,
  packageShares,
  integrationConnections,
  packages,
} from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { requiredScopesForAgent, resolveEffectiveToolSelection } from "@appstrate/core/integration";

import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { notEphemeralFilter, orgOrSystemFilter } from "../lib/package-helpers.ts";
import { activeHereSql } from "./package-activation.ts";
import { getIntegration } from "./integration-service.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";

interface ComputeRequiredScopesResult {
  /** Union over all agents — the set to add to the IdP authorize request. */
  required: string[];
}

interface ScopeResolverInput {
  scope: SpaceScope;
  integrationId: string;
  /** Auth key on the integration manifest — selects the `required_scopes[authKey]` slice. */
  authKey: string;
}

/**
 * Compute the OAuth scope set required by every agent the space RUNS that
 * depends on this integration's auth. Returns an empty `required` array when
 * no active agent uses the integration (callers should fall back to the
 * manifest defaults).
 *
 * Resolves the integration manifest fresh from DB on every call — cheap
 * (one row lookup + JSON parse) and avoids a stale cache hiding scope
 * additions made after the app booted.
 */
export async function computeRequiredScopes(
  input: ScopeResolverInput,
): Promise<ComputeRequiredScopesResult> {
  const integration = await getIntegration(input.scope, input.integrationId);
  if (!integration) {
    return { required: [] };
  }

  // Resolve the auth this kickoff is for. Unknown auth key = nothing to
  // contribute (the kickoff route guards earlier, but be defensive).
  if (!integration.manifest.auths || !integration.manifest.auths[input.authKey]) {
    return { required: [] };
  }

  // Walk the ACTIVE agents. We need the manifest of each to read its
  // `integrations_configuration`; that lives on `draftManifest`, same
  // column the runtime resolver reads at spawn time.
  //
  // ACTIVE and not merely row-present ({@link activeHereSql}, both of its
  // LEFT JOINs below): a required scope is one some run will actually ask the
  // IdP for, and a deactivated agent — or an ORPHAN row, naming a package this
  // space has lost — never runs. Counting it would raise the consent floor for
  // an agent nobody can execute, and an IdP-side shrink below it would flag a
  // healthy connection as under-scoped.
  //
  // The set moves in BOTH directions, and the second is the one to notice: the
  // scan starts from `packages` rather than from `space_packages`, so a SYSTEM
  // agent the deployment switches on with no row at all is now counted where
  // before only row-holders were. That is the same correction, not a separate
  // one — such an agent runs here, so the scopes it needs are scopes some run
  // will ask for, and leaving them out under-scoped the connection for the one
  // cohort nobody had to activate. A deployment shipping system agents that
  // declare this integration will see the floor RISE on the next refresh
  // check; that floor is what those agents already require to run.
  //
  // `orgOrSystemFilter` + `notEphemeralFilter` come with the change of base
  // table: reading `packages` directly puts every catalogue row in reach,
  // including another organization's and an inline run's shadow, neither of
  // which a join from `space_packages` could ever have returned.
  const { orgId, spaceId } = input.scope;
  const active = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
    .where(
      and(
        eq(packages.type, "agent"),
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        activeHereSql(spaceId),
      ),
    );

  const required = new Set<string>();

  for (const agent of active) {
    if (!agent.draftManifest || typeof agent.draftManifest !== "object") continue;
    const integEntries = parseManifestIntegrations(agent.draftManifest as Record<string, unknown>);
    const entry = integEntries.find((e) => e.id === input.integrationId);
    if (!entry) continue;

    // Resolve the effective selection BEFORE inferring scopes so a tool the
    // agent inherits via the integration's `default_tools` (AFPS §4.4)
    // contributes its OAuth scopes — otherwise a zero-config agent would spawn
    // the default `api_call` but request no scopes, leaving the connection
    // under-scoped. Precedence (mirrors the spawn resolver):
    //   entry.tools = "*"  → wildcard, scopes fall back to the auth's
    //                        `default_scopes` (§7.4).
    //   entry.tools = []   → explicit "zero tools" → zero inferred scopes
    //                        (overrides any default).
    //   entry.tools = [..] → per-tool scope union.
    //   entry.tools = undefined (no integrations_configuration entry, or one
    //                        without `tools`) → integration `default_tools`,
    //                        or still "no tools used" if none declared.
    const effectiveTools = resolveEffectiveToolSelection(entry.tools, integration.manifest);
    for (const s of requiredScopesForAgent({
      manifest: integration.manifest,
      authKey: input.authKey,
      agentTools: effectiveTools,
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
  scope: SpaceScope;
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
        eq(integrationConnections.spaceId, input.scope.spaceId),
        actorFilter(input.actor, {
          userId: integrationConnections.userId,
          endUserId: integrationConnections.endUserId,
        }),
      ),
    );
  return rows[0]?.scopesGranted ?? [];
}
