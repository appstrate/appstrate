// SPDX-License-Identifier: Apache-2.0

/**
 * What to call the agent a run executed.
 *
 * Four fallbacks deep, because a run outlives its agent: the live display name
 * when the agent still exists, the manifest snapshot for an inline run (whose
 * shadow package id `@inline/r-…` means nothing to anyone), the denormalized
 * `agent_name` stamped at INSERT time when the source agent was deleted, and
 * the package id last.
 *
 * It ALWAYS returns a name. A surface that shows the agent in its title drops
 * the COLUMN — it does not blank the name, which is also what the row's
 * accessible label is built from: hiding the column used to leave every row
 * announcing "Run #42 —".
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useAgents } from "./use-packages";
import { inlineRunDisplayName } from "../lib/run-title";

export interface RunAgentNaming {
  /** Display name per package id, from the agents the org can see. */
  byPackageId: Map<string, string>;
  /** The single agent every run of this surface belongs to, when it has one. */
  fixed?: string;
  t: TFunction;
}

/** Exported pure, so the fallback chain can be tested without a query client. */
export function resolveRunAgentName(run: EnrichedRun, naming: RunAgentNaming): string {
  if (naming.fixed) return naming.fixed;
  if (run.package_ephemeral === true) {
    return inlineRunDisplayName(run.agent_name, naming.t("runs.inlineBadge", { ns: "agents" }));
  }
  // Source agent deleted (FK SET NULL): the run row survives, the agent does not.
  if (run.packageId == null) {
    return run.agent_name ?? naming.t("runs.deletedAgent", { ns: "agents" });
  }
  return naming.byPackageId.get(run.packageId) ?? run.agent_name ?? run.packageId;
}

/**
 * `useAgents()` here is not an extra request: it is the same query key every
 * caller of this hook already holds, served from cache.
 */
export function useRunAgentName(fixedAgentName?: string): (run: EnrichedRun) => string {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();

  const byPackageId = new Map<string, string>();
  if (!fixedAgentName && agents) {
    for (const agent of agents) byPackageId.set(agent.id, agent.display_name ?? agent.id);
  }

  return (run) => resolveRunAgentName(run, { byPackageId, fixed: fixedAgentName, t });
}
