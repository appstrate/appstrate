// SPDX-License-Identifier: Apache-2.0

import { requiredScopesForAgent } from "@appstrate/core/integration";
import type {
  AgentIntegrationEntry,
  IntegrationManifestAuth,
  IntegrationManifestView,
} from "../../hooks/use-integrations";

type ScopeCatalogEntry = NonNullable<IntegrationManifestAuth["scope_catalog"]>[number];

/** One auth's "+ Ajouter" with a choice of scopes. */
export interface ScopeTarget {
  packageId: string;
  authKey: string;
  manifest: IntegrationManifestView;
  choice: ScopeChoice;
}

/**
 * What "+ Ajouter" offers for one auth. Every connect requests
 * `default_scopes ∪ requested scopes`, so the defaults are a fixed baseline and
 * only the rest of the `scope_catalog` is a choice.
 */
export interface ScopeChoice {
  /** The defaults to show, without those another default implies (`scope_catalog[].implies`). */
  baseline: string[];
  selectable: ScopeCatalogEntry[];
}

/** `null` when there is nothing to choose: not oauth2, no catalog, or an all-baseline catalog. */
export function scopeChoiceFor(auth: IntegrationManifestAuth | undefined): ScopeChoice | null {
  if (auth?.type !== "oauth2" || !auth.scope_catalog) return null;
  const defaults = auth.default_scopes ?? [];
  const selectable = auth.scope_catalog.filter((entry) => !defaults.includes(entry.value));
  if (selectable.length === 0) return null;
  const implied = new Set(
    auth.scope_catalog
      .filter((entry) => defaults.includes(entry.value))
      .flatMap((entry) => entry.implies ?? []),
  );
  return { baseline: defaults.filter((scope) => !implied.has(scope)), selectable };
}

/**
 * The selectable scopes an agent's declaration needs on `authKey`: what the quick-fill ticks.
 * A declaration pinned to another auth (`auth_key`) needs nothing here.
 */
export function agentScopes(
  choice: ScopeChoice,
  manifest: IntegrationManifestView,
  authKey: string,
  entry: Pick<AgentIntegrationEntry, "tools" | "scopes" | "auth_key">,
): string[] {
  if (entry.auth_key !== undefined && entry.auth_key !== authKey) return [];
  const required = new Set(
    requiredScopesForAgent({
      manifest,
      authKey,
      agentTools: entry.tools,
      agentScopes: entry.scopes,
    }),
  );
  return choice.selectable.filter((e) => required.has(e.value)).map((e) => e.value);
}

/** The hosted connect input: ticked scopes in catalog order, none at all for the baseline alone. */
export function connectPopupInput(
  target: { packageId: string; authKey: string; choice: ScopeChoice | null },
  ticked: readonly string[],
  forceAccountSelect: boolean,
): { packageId: string; authKey: string; scopes?: string[]; forceAccountSelect?: true } {
  const scopes = (target.choice?.selectable ?? [])
    .filter((e) => ticked.includes(e.value))
    .map((e) => e.value);
  return {
    packageId: target.packageId,
    authKey: target.authKey,
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(forceAccountSelect ? { forceAccountSelect: true as const } : {}),
  };
}
