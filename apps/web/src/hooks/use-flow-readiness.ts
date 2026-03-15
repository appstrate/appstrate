import { useMemo } from "react";
import type { FlowDetail, JSONSchemaObject, OrgModelInfo } from "@appstrate/shared-types";
import {
  isPromptEmpty,
  findMissingDependencies,
  checkRequiredConfig,
} from "../lib/flow-readiness.ts";

export function useFlowReadiness(
  detail: FlowDetail | undefined,
  flowModelId?: string | null,
  orgModels?: OrgModelInfo[],
  configSchemaOverride?: JSONSchemaObject,
) {
  return useMemo(() => {
    const configSchema = configSchemaOverride ?? detail?.config?.schema;
    return {
      allConnected: detail
        ? detail.dependencies.providers.every(
            (s) =>
              (s.status === "connected" || s.status === "needs_reconnection") &&
              s.scopesSufficient !== false,
          )
        : false,
      hasReconnectionNeeded: detail
        ? detail.dependencies.providers.some((s) => s.status === "needs_reconnection")
        : false,
      hasRequiredConfig: detail
        ? checkRequiredConfig(detail.config?.current || {}, configSchema?.required || []).valid
        : false,
      hasConfigSchema: !!(
        configSchema?.properties && Object.keys(configSchema.properties).length > 0
      ),
      hasModel:
        orgModels !== undefined
          ? !!flowModelId || orgModels.some((m) => m.isDefault && m.enabled)
          : true,
      hasPrompt: detail ? !isPromptEmpty(detail.prompt ?? "") : false,
      hasRequiredSkills: detail
        ? findMissingDependencies(
            (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)
              ?.skills ?? {},
            detail.dependencies.skills.map((s: { id: string }) => s.id),
          ).length === 0
        : true,
      hasRequiredTools: detail
        ? findMissingDependencies(
            (detail.manifest?.dependencies as Record<string, Record<string, string>> | undefined)
              ?.tools ?? {},
            detail.dependencies.tools.map((e: { id: string }) => e.id),
          ).length === 0
        : true,
    };
  }, [detail, flowModelId, orgModels, configSchemaOverride]);
}
