// SPDX-License-Identifier: Apache-2.0

import { requiredScopesForAgent } from "@appstrate/core/integration";
import type {
  AgentIntegrationEntry,
  IntegrationManifestAuth,
  IntegrationManifestView,
} from "../../hooks/use-integrations";

type ScopeCatalogEntry = NonNullable<IntegrationManifestAuth["scope_catalog"]>[number];
type AgentDeclaration = Pick<AgentIntegrationEntry, "id" | "tools" | "scopes">;

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

/**
 * A pick in the agent quick-fill: the agent's selectable scopes for this integration added to
 * `ticked`. `added` is false when nothing new is ticked: the baseline covers the agent, it
 * uses another auth, or the definition read does not declare the integration.
 */
export async function tickAgentScopes(input: {
  loadAgent: () => Promise<{ dependencies: { integrations: readonly AgentDeclaration[] } }>;
  integrationId: string;
  manifest: IntegrationManifestView;
  authKey: string;
  choice: ScopeChoice;
  ticked: readonly string[];
}): Promise<{ ticked: string[]; added: boolean }> {
  const { choice, manifest, authKey, ticked } = input;
  const agent = await input.loadAgent();
  const entry = agent.dependencies.integrations.find((i) => i.id === input.integrationId);
  const scopes = entry ? scopesForAgent(choice, { manifest, authKey, agent: entry }) : [];
  const fresh = scopes.filter((scope) => !ticked.includes(scope));
  return { ticked: [...ticked, ...fresh], added: fresh.length > 0 };
}

/** The ticked scopes to request, in catalog order; `[]` connects with the baseline alone. */
export function requestedScopes(choice: ScopeChoice, ticked: readonly string[]): string[] {
  const picked = new Set(ticked);
  return choice.selectable.filter((entry) => picked.has(entry.value)).map((e) => e.value);
}
