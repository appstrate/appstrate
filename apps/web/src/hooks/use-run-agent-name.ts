// SPDX-License-Identifier: Apache-2.0

/**
 * What to call the agent a run executed. A run outlives its agent, hence the fallbacks: live
 * display name, inline manifest snapshot, `agent_name` stamped at INSERT, package id.
 * ALWAYS returns a name (it feeds the row's accessible label); a surface drops the column instead.
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useAgents } from "./use-packages";
import { inlineRunDisplayName } from "../lib/run-title";

export interface RunAgentNaming {
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

export function useRunAgentName(fixedAgentName?: string): (run: EnrichedRun) => string {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();

  const byPackageId = new Map<string, string>();
  if (!fixedAgentName && agents) {
    for (const agent of agents) byPackageId.set(agent.id, agent.display_name ?? agent.id);
  }

  return (run) => resolveRunAgentName(run, { byPackageId, fixed: fixedAgentName, t });
}
