// SPDX-License-Identifier: Apache-2.0

import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentModel, useModels, type OrgModelInfo } from "./use-models";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { isModelSelectable } from "../lib/model-selectability";

/**
 * Will a run get a model? Mirrors the server cascade (`resolveModel`): the
 * agent pin wins when it is usable, otherwise the org default is tried.
 *
 * A pin alone is NOT enough — a pinned model on a dead credential resolves to
 * null server-side, so counting it would green-light a run that cannot reach
 * any inference endpoint. An unusable pin is not fatal either: `resolveModel`
 * falls through to the org default, whether the pin is unusable or absent from
 * the list entirely (row deleted, or its provider gone).
 *
 * Exported for its unit test — `agentRunBlocker` is the only production caller.
 */
export function resolvesToUsableModel(
  orgModels: OrgModelInfo[],
  agentModelId?: string | null,
): boolean {
  const pinned = agentModelId ? orgModels.find((m) => m.id === agentModelId) : undefined;
  if (pinned && isModelSelectable(pinned)) return true;
  return orgModels.some((m) => m.is_default && isModelSelectable(m));
}

/** i18n key (namespace `agents`) of the reason a run of an agent cannot start. */
export type AgentRunBlocker =
  | "detail.titleNotActive"
  | "detail.titleEmptyPrompt"
  | "detail.titleMissingSkill"
  | "detail.titleModel"
  | "detail.titleNoDefaultModel";

/**
 * What blocks a run of this agent in this space, or `null`. Every launch
 * control of the agent page reads this one verdict, so two buttons cannot
 * disagree about the same agent.
 *
 * The order is the server's: the run gate refuses an agent that is not active
 * here before it looks at anything else.
 *
 * Unfilled parameters are deliberately NOT a gate: an agent declares one
 * `input` schema and every field it does not already decide (author `default`
 * or an editor value) is asked at launch. The only configuration that could
 * make a required field unsatisfiable — locking it with nothing behind it —
 * is refused at write time (400 `locked_required_field_empty`), so it cannot
 * reach a launch surface. Missing integration connections are not one either:
 * the launch answers them with the recovery modal.
 */
export function agentRunBlocker(
  detail: AgentDetail,
  orgModels: OrgModelInfo[] | undefined,
  agentModelId?: string | null,
): AgentRunBlocker | null {
  if (!detail.active) return "detail.titleNotActive";
  // A summary read (`agents:run` without `agents:read`) carries no prompt and
  // no manifest. Absent is unknown, not empty: the server judges at launch.
  if (detail.prompt !== undefined && isPromptEmpty(detail.prompt)) {
    return "detail.titleEmptyPrompt";
  }
  const requiredSkills =
    (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)?.skills ??
    {};
  const placedSkills = detail.dependencies.skills?.map((s) => s.id) ?? [];
  if (findMissingDependencies(requiredSkills, placedSkills).length > 0) {
    return "detail.titleMissingSkill";
  }
  // Unknown catalog (still loading) is optimistic — don't flash "no model".
  if (orgModels !== undefined && !resolvesToUsableModel(orgModels, agentModelId)) {
    // Models the org could run on, none of them the default: a different fix.
    return orgModels.some(isModelSelectable) ? "detail.titleNoDefaultModel" : "detail.titleModel";
  }
  return null;
}

/** {@link agentRunBlocker} for the agent a page is showing. */
export function useAgentRunBlocker(detail: AgentDetail | undefined): AgentRunBlocker | null {
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(detail?.id);
  return detail ? agentRunBlocker(detail, orgModels, agentModel?.modelId) : null;
}
