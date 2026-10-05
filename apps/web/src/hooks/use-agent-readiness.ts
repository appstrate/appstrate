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

/**
 * True when there is nothing this caller could launch: the package has no
 * published version (`definition === "draft"` is all the detail route could
 * render) and the working copy is not theirs to run. A launch would send no
 * selector and the server would answer `404 no_published_version`.
 */
export function isNeverPublishedForReader(detail: AgentDetail | undefined): boolean {
  return !!detail && detail.definition === "draft" && !detail.home_writable;
}

/** i18n key (namespace `agents`) of a refusal no launch option can cure. */
type AgentLaunchRefusal = "detail.titleNotActive" | "detail.titleNeverPublished";

/**
 * The two refusals every launch of this agent meets, whatever options it is
 * sent with: switched off in this space, or nothing published and a working
 * copy that is not the caller's. "Run with options" gates on these alone — a
 * model, a version or a prompt it can still change there.
 *
 * Switched off HERE comes first: its cure is one click away on the page, while
 * publishing is somebody else's act.
 */
export function agentLaunchRefusal(detail: AgentDetail): AgentLaunchRefusal | null {
  if (!detail.active) return "detail.titleNotActive";
  if (isNeverPublishedForReader(detail)) return "detail.titleNeverPublished";
  return null;
}

/** i18n key (namespace `agents`) of the model problem that blocks a run. */
type AgentModelBlocker = "detail.titleModel" | "detail.titleNoDefaultModel";

/** i18n key (namespace `agents`) of the reason a run of an agent cannot start. */
type AgentRunBlocker =
  AgentLaunchRefusal | "detail.titleEmptyPrompt" | "detail.titleMissingSkill" | AgentModelBlocker;

/**
 * The model half of the verdict, on its own: it depends on the catalog and the
 * agent's pin, not on the agent's definition, so the page can state it even
 * when something else blocks the run first.
 */
export function agentModelBlocker(
  orgModels: OrgModelInfo[] | undefined,
  agentModelId?: string | null,
): AgentModelBlocker | null {
  // Unknown catalog (still loading) is optimistic — don't flash "no model".
  if (orgModels === undefined || resolvesToUsableModel(orgModels, agentModelId)) return null;
  // Models the org could run on, none of them the default: a different fix.
  return orgModels.some(isModelSelectable) ? "detail.titleNoDefaultModel" : "detail.titleModel";
}

/**
 * What blocks a plain run of this agent in this space, or `null`. The two Run
 * buttons of the agent page (header, empty runs list) read this one verdict,
 * so they cannot disagree about the same agent.
 *
 * {@link agentLaunchRefusal} first, then what the definition lacks, then the
 * model.
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
  const refusal = agentLaunchRefusal(detail);
  if (refusal) return refusal;
  // A summary read (`agents:run` without `agents:read`) OMITS the prompt:
  // absent is unknown, and the server judges at launch. A full read always
  // carries a string (`package-catalog.ts` reads a null draft as "").
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
  return agentModelBlocker(orgModels, agentModelId);
}

/** {@link agentRunBlocker} for the agent a page is showing. */
export function useAgentRunBlocker(detail: AgentDetail | undefined): AgentRunBlocker | null {
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(detail?.id);
  return detail ? agentRunBlocker(detail, orgModels, agentModel?.modelId) : null;
}

/** {@link agentModelBlocker} for the agent a page is showing. */
export function useAgentModelBlocker(packageId: string): AgentModelBlocker | null {
  const { data: orgModels } = useModels();
  const { data: agentModel } = useAgentModel(packageId);
  return agentModelBlocker(orgModels, agentModel?.modelId);
}
