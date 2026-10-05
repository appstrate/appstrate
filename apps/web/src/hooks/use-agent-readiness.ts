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
 * Exported for its unit test — `agentModelBlocker` is the only production caller.
 */
export function resolvesToUsableModel(
  orgModels: OrgModelInfo[],
  agentModelId?: string | null,
): boolean {
  const pinned = agentModelId ? orgModels.find((m) => m.id === agentModelId) : undefined;
  if (pinned && isModelSelectable(pinned)) return true;
  return orgModels.some((m) => m.is_default && isModelSelectable(m));
}

/** Nothing published, and the working copy is not this caller's to run (`404 no_published_version`). */
export function isNeverPublishedForReader(detail: AgentDetail | undefined): boolean {
  return !!detail && detail.definition === "draft" && !detail.home_writable;
}

type AgentLaunchRefusal = "detail.titleNotActive" | "detail.titleNeverPublished";
type AgentModelBlocker = "detail.titleModel" | "detail.titleNoDefaultModel";
type AgentRunBlocker =
  AgentLaunchRefusal | "detail.titleEmptyPrompt" | "detail.titleMissingSkill" | AgentModelBlocker;

/**
 * The refusals no launch option can cure, as i18n keys (namespace `agents`).
 * Switched off here comes first: its cure is one click away on the page.
 */
export function agentLaunchRefusal(detail: AgentDetail): AgentLaunchRefusal | null {
  if (!detail.active) return "detail.titleNotActive";
  if (isNeverPublishedForReader(detail)) return "detail.titleNeverPublished";
  return null;
}

/** The model half of the verdict. A catalog still loading is not a blocker. */
export function agentModelBlocker(
  orgModels: OrgModelInfo[] | undefined,
  agentModelId?: string | null,
): AgentModelBlocker | null {
  if (orgModels === undefined || resolvesToUsableModel(orgModels, agentModelId)) return null;
  return orgModels.some(isModelSelectable) ? "detail.titleNoDefaultModel" : "detail.titleModel";
}

/**
 * What blocks a plain run of this agent in this space. Unfilled parameters and
 * missing integration connections are not gates: the launch asks for them.
 */
export function agentRunBlocker(
  detail: AgentDetail,
  modelBlocker: AgentModelBlocker | null,
): AgentRunBlocker | null {
  const refusal = agentLaunchRefusal(detail);
  if (refusal) return refusal;
  // A summary read (`agents:run` without `agents:read`) omits the prompt:
  // absent is unknown, not empty.
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
  return modelBlocker;
}

export function useAgentModelBlocker(packageId: string): AgentModelBlocker | null {
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  return agentModelBlocker(orgModels, agentModel?.modelId);
}

export function useAgentRunBlocker(
  packageId: string,
  detail: AgentDetail | undefined,
): AgentRunBlocker | null {
  const modelBlocker = useAgentModelBlocker(packageId);
  return detail ? agentRunBlocker(detail, modelBlocker) : null;
}
