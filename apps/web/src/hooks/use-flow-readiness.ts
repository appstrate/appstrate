import { useMemo } from "react";
import type { FlowDetail, OrgModelInfo } from "@appstrate/shared-types";
import {
  isPromptEmpty,
  findMissingDependencies,
  checkRequiredConfig,
} from "@appstrate/core/flow-readiness";

export function useFlowReadiness(
  detail: FlowDetail | undefined,
  flowModelId?: string | null,
  orgModels?: OrgModelInfo[],
) {
  return useMemo(
    () => ({
      allConnected: detail
        ? detail.requires.providers.every(
            (s) =>
              (s.status === "connected" || s.status === "needs_reconnection") &&
              s.scopesSufficient !== false,
          )
        : false,
      hasReconnectionNeeded: detail
        ? detail.requires.providers.some((s) => s.status === "needs_reconnection")
        : false,
      hasRequiredConfig: detail
        ? checkRequiredConfig(detail.config?.current || {}, detail.config?.schema?.required || [])
            .valid
        : false,
      hasConfigSchema: detail
        ? !!(
            detail.config?.schema?.properties &&
            Object.keys(detail.config.schema.properties).length > 0
          )
        : false,
      hasModel:
        orgModels !== undefined
          ? !!flowModelId || orgModels.some((m) => m.isDefault && m.enabled)
          : true,
      hasPrompt: detail ? !isPromptEmpty(detail.prompt ?? "") : false,
      hasRequiredSkills: detail
        ? findMissingDependencies(
            (detail.manifest?.requires as Record<string, Record<string, string>> | undefined)
              ?.skills ?? {},
            detail.requires.skills.map((s: { id: string }) => s.id),
          ).length === 0
        : true,
      hasRequiredExtensions: detail
        ? findMissingDependencies(
            (detail.manifest?.requires as Record<string, Record<string, string>> | undefined)
              ?.extensions ?? {},
            detail.requires.extensions.map((e: { id: string }) => e.id),
          ).length === 0
        : true,
    }),
    [detail, flowModelId, orgModels],
  );
}
