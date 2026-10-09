// SPDX-License-Identifier: Apache-2.0

import { requiredScopesForAgent } from "@appstrate/core/integration";
import type {
  AgentIntegrationEntry,
  IntegrationManifestAuth,
  IntegrationManifestView,
} from "../../hooks/use-integrations";

type ScopeCatalogEntry = NonNullable<IntegrationManifestAuth["scope_catalog"]>[number];

/**
 * What "+ Ajouter" offers for one auth. Every connect requests
 * `default_scopes ∪ requested scopes`, so the defaults are a fixed baseline and
 * only the rest of the `scope_catalog` is a choice.
 */
export interface ScopeChoice {
  baseline: string[];
  selectable: ScopeCatalogEntry[];
}

/** `null` when there is nothing to choose: not oauth2, no catalog, or an all-baseline catalog. */
export function scopeChoiceFor(auth: IntegrationManifestAuth | undefined): ScopeChoice | null {
  if (auth?.type !== "oauth2" || !auth.scope_catalog) return null;
  const baseline = auth.default_scopes ?? [];
  const selectable = auth.scope_catalog.filter((entry) => !baseline.includes(entry.value));
  return selectable.length > 0 ? { baseline, selectable } : null;
}

/** The selectable scopes an agent needs on `authKey`: what the agent quick-fill ticks. */
export function scopesForAgent(
  choice: ScopeChoice,
  input: {
    manifest: IntegrationManifestView;
    authKey: string;
    agent: Pick<AgentIntegrationEntry, "tools" | "scopes">;
  },
): string[] {
  const required = new Set(
    requiredScopesForAgent({
      manifest: input.manifest,
      authKey: input.authKey,
      agentTools: input.agent.tools,
      agentScopes: input.agent.scopes,
    }),
  );
  return choice.selectable.filter((entry) => required.has(entry.value)).map((e) => e.value);
}

/** The ticked scopes to request, in catalog order; `[]` connects with the baseline alone. */
export function requestedScopes(choice: ScopeChoice, ticked: readonly string[]): string[] {
  const picked = new Set(ticked);
  return choice.selectable.filter((entry) => picked.has(entry.value)).map((e) => e.value);
}
