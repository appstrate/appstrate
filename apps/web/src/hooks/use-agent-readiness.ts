// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { OrgModelInfo } from "./use-models";
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
 * Exported for its unit test — the hook below is the only production caller.
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
 * What still blocks a run of this agent.
 *
 * Unfilled parameters are deliberately NOT a gate: an agent declares one
 * `input` schema and every field it does not already decide (author `default`
 * or an editor value) is asked at launch. The only configuration that could
 * make a required field unsatisfiable — locking it with nothing behind it —
 * is refused at write time (400 `locked_required_field_empty`), so it cannot
 * reach a launch surface.
 */
export function useAgentReadiness(
  detail: AgentDetail | undefined,
  agentModelId?: string | null,
  orgModels?: OrgModelInfo[],
) {
  return useMemo(
    () => ({
      // Unknown catalog (still loading) is optimistic — don't flash "no model".
      hasModel: orgModels !== undefined ? resolvesToUsableModel(orgModels, agentModelId) : true,
      hasPrompt: detail ? !isPromptEmpty(detail.prompt ?? "") : false,
      hasRequiredSkills: detail
        ? findMissingDependencies(
            (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)
              ?.skills ?? {},
            detail.dependencies.skills.map((s: { id: string }) => s.id),
          ).length === 0
        : true,
    }),
    [detail, agentModelId, orgModels],
  );
}
