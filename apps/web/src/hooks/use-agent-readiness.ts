// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import type { AgentDetail } from "@appstrate/shared-types";
import type { OrgModelInfo } from "./use-models";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { isModelSelectable } from "../lib/model-selectability";

/**
 * A pin the org can no longer see (row deleted, or its credential/provider
 * gone so `GET /api/models` drops it) is not a failure here — the server falls
 * through to the org default for exactly that case. Only a pin that IS listed
 * and is unusable counts as "no model from the pin".
 */
function isPinUsable(orgModels: OrgModelInfo[], agentModelId?: string | null): boolean {
  if (!agentModelId) return false;
  const pinned = orgModels.find((m) => m.id === agentModelId);
  return pinned ? isModelSelectable(pinned) : false;
}

export function useAgentReadiness(
  detail: AgentDetail | undefined,
  agentModelId?: string | null,
  orgModels?: OrgModelInfo[],
  configSchemaOverride?: JSONSchemaObject,
) {
  return useMemo(() => {
    const configSchema = configSchemaOverride ?? detail?.config?.schema;
    return {
      hasRequiredConfig: detail
        ? (configSchema?.required || []).every((key) => {
            const val = (detail.config?.current || {})[key];
            return val !== undefined && val !== null && val !== "";
          })
        : false,
      hasConfigSchema: !!(
        configSchema?.properties && Object.keys(configSchema.properties).length > 0
      ),
      // Mirrors the server cascade (`resolveModel`): the agent pin wins when
      // it is usable, otherwise the org default is tried. A pin alone is NOT
      // enough — a pinned model on a dead credential resolves to null server
      // side, so counting it as "has a model" would green-light a run that
      // cannot reach any inference endpoint.
      hasModel:
        orgModels !== undefined
          ? isPinUsable(orgModels, agentModelId) ||
            orgModels.some((m) => m.is_default && isModelSelectable(m))
          : true,
      hasPrompt: detail ? !isPromptEmpty(detail.prompt ?? "") : false,
      hasRequiredSkills: detail
        ? findMissingDependencies(
            (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)
              ?.skills ?? {},
            detail.dependencies.skills.map((s: { id: string }) => s.id),
          ).length === 0
        : true,
    };
  }, [detail, agentModelId, orgModels, configSchemaOverride]);
}
