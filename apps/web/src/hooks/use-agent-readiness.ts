// SPDX-License-Identifier: Apache-2.0

import type { AgentDetail } from "@appstrate/shared-types";
import { useAgentModel, useModels, type OrgModelInfo } from "./use-models";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { isModelSelectable } from "@appstrate/core/model-selectable";

/**
 * Will a run get a model? Mirrors `resolveModel`: a usable agent pin wins (a pin on a dead
 * credential resolves to null server-side), else the org default. An unusable or missing pin
 * falls through to the default. Exported for its test.
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

type AgentLaunchRefusal =
  "detail.titleNotActive" | "detail.titleNotActiveAcross" | "detail.titleNeverPublished";
type AgentModelBlocker = "detail.titleModel" | "detail.titleNoDefaultModel";
type AgentRunBlocker =
  AgentLaunchRefusal | "detail.titleEmptyPrompt" | "detail.titleMissingSkill" | AgentModelBlocker;

/** Every blocker key, checked exhaustive by `satisfies`: the run button renders `t(blocker)`, so a test holds each in both locales. */
export const AGENT_RUN_BLOCKERS = Object.keys({
  "detail.titleNotActive": true,
  "detail.titleNotActiveAcross": true,
  "detail.titleNeverPublished": true,
  "detail.titleEmptyPrompt": true,
  "detail.titleMissingSkill": true,
  "detail.titleModel": true,
  "detail.titleNoDefaultModel": true,
} satisfies Record<AgentRunBlocker, true>);

/**
 * Where a verdict is judged: the space the detail was read in, or, `spanning` (« Tous les espaces »,
 * the space chosen at launch), only on what holds in every space; the launch answers the rest.
 */
interface VerdictScope {
  spanning?: boolean;
}

/** The refusals no launch option can cure, as i18n keys (namespace `agents`); switched off comes first (one click cures it). */
export function agentLaunchRefusal(
  detail: AgentDetail,
  { spanning = false }: VerdictScope = {},
): AgentLaunchRefusal | null {
  if (!spanning && !detail.active) return "detail.titleNotActive";
  if (spanning && detail.space_ids.length === 0) return "detail.titleNotActiveAcross";
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

/** What blocks a plain run. Unfilled parameters and missing connections are not gates: the launch asks for them. */
export function agentRunBlocker(
  detail: AgentDetail,
  modelBlocker: AgentModelBlocker | null,
  scope: VerdictScope = {},
): AgentRunBlocker | null {
  const refusal = agentLaunchRefusal(detail, scope);
  if (refusal) return refusal;
  // A summary read (`agents:run` without `agents:read`) omits the prompt: absent is unknown.
  if (detail.prompt !== undefined && isPromptEmpty(detail.prompt)) {
    return "detail.titleEmptyPrompt";
  }
  // The skills a run gets are those placed in the space it runs in.
  if (scope.spanning) return modelBlocker;
  const requiredSkills =
    (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)?.skills ??
    {};
  const placedSkills = detail.dependencies.skills?.map((s) => s.id) ?? [];
  if (findMissingDependencies(requiredSkills, placedSkills).length > 0) {
    return "detail.titleMissingSkill";
  }
  return modelBlocker;
}

/**
 * `undefined` for a page that is not an agent's: neither read is made. `spanning` reads no space's
 * pin and blocks only on an organization with no usable model: a pin in the chosen space may
 * answer a missing default.
 */
export function useAgentModelBlocker(
  packageId: string | undefined,
  { spanning = false }: VerdictScope = {},
): AgentModelBlocker | null {
  const { data: orgModels } = useModels(packageId !== undefined);
  const { data: agentModel } = useAgentModel(spanning ? undefined : packageId);
  const blocker = agentModelBlocker(orgModels, agentModel?.modelId);
  return spanning && blocker === "detail.titleNoDefaultModel" ? null : blocker;
}

export function useAgentRunBlocker(
  packageId: string,
  detail: AgentDetail | undefined,
  scope: VerdictScope = {},
): AgentRunBlocker | null {
  const modelBlocker = useAgentModelBlocker(packageId, scope);
  return detail ? agentRunBlocker(detail, modelBlocker, scope) : null;
}
