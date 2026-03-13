import { useMemo } from "react";
import type { FlowDetail, OrgModelInfo } from "@appstrate/shared-types";

function checkRequiredConfig(detail: FlowDetail): boolean {
  const schema = detail.config?.schema;
  const current = detail.config?.current || {};
  if (!schema?.properties) return true;
  for (const key of schema.required || []) {
    if (current[key] === undefined || current[key] === null || current[key] === "") {
      return false;
    }
  }
  return true;
}

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
      hasRequiredConfig: detail ? checkRequiredConfig(detail) : false,
      hasConfigSchema: detail
        ? !!(
            detail.config?.schema?.properties &&
            Object.keys(detail.config.schema.properties).length > 0
          )
        : false,
      hasModel: orgModels !== undefined ? !!flowModelId || orgModels.some((m) => m.enabled) : true,
    }),
    [detail, flowModelId, orgModels],
  );
}
