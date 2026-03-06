import { useState, type ReactNode } from "react";
import type { FlowDetail, JSONSchemaObject, Schedule } from "@appstrate/shared-types";
import { useCurrentProfileId, profileIdParam } from "../hooks/use-current-profile";
import {
  useRunFlow,
  useConnect,
  useDeleteFlow,
  useDeleteFlowExecutions,
  useConnectApiKey,
  useConnectCredentials,
  useBindAdminService,
  useUnbindAdminService,
  useDisconnect,
  useDeleteMemory,
  useDeleteAllMemories,
} from "../hooks/use-mutations";
import {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import { useExecutions } from "../hooks/use-executions";
import { useFlowMemories } from "../hooks/use-memories";
import { useProviders } from "../hooks/use-providers";
import { useProxies, useFlowProxy, useSetFlowProxy } from "../hooks/use-proxies";
import { useProfiles } from "../hooks/use-profiles";
import { FlowDetailContext, type FlowDetailContextValue } from "./flow-detail-context-value";

export type { FlowDetailContextValue };

interface ApiKeyServiceState {
  provider: string;
  id: string;
  bindAfter?: boolean;
}

interface CustomCredServiceState {
  provider: string;
  id: string;
  name?: string;
  bindAfter?: boolean;
}

function checkRequiredConfig(detail: {
  config: {
    schema: { properties: Record<string, unknown>; required?: string[] };
    current: Record<string, unknown>;
  };
}): boolean {
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

export function FlowDetailProvider({
  detail,
  packageId,
  isOrgAdmin,
  children,
}: {
  detail: FlowDetail;
  packageId: string;
  isOrgAdmin: boolean;
  children: ReactNode;
}) {
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);

  const { data: executions } = useExecutions(packageId);
  const { data: schedules } = useSchedules(packageId);
  const { data: memories } = useFlowMemories(packageId);
  const { data: providers } = useProviders();
  const { data: orgProxies } = useProxies();
  const { data: flowProxy } = useFlowProxy(packageId);
  const setFlowProxy = useSetFlowProxy(packageId);

  const profileMap = useProfiles(
    (executions ?? []).map((e) => e.userId).filter((id): id is string => !!id),
  );

  const runFlow = useRunFlow(packageId);
  const deleteFlow = useDeleteFlow();
  const deleteExecutions = useDeleteFlowExecutions(packageId);
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();
  const bindAdmin = useBindAdminService(packageId);
  const unbindAdmin = useUnbindAdminService(packageId);
  const disconnectMutation = useDisconnect();
  const createSchedule = useCreateSchedule(packageId);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const deleteMemory = useDeleteMemory(packageId);
  const deleteAllMemories = useDeleteAllMemories(packageId);

  // Modal states
  const [configOpen, setConfigOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [apiKeyService, setApiKeyService] = useState<ApiKeyServiceState | null>(null);
  const [customCredService, setCustomCredService] = useState<CustomCredServiceState | null>(null);

  // Derived
  const customCredProviderDef = customCredService
    ? providers?.find((p) => p.id === customCredService.provider)
    : undefined;
  const customCredSchema =
    (customCredProviderDef?.credentialSchema as JSONSchemaObject | undefined) ?? undefined;

  const allConnected = detail.requires.services.every(
    (s) =>
      (s.status === "connected" || s.status === "needs_reconnection") &&
      s.scopesSufficient !== false,
  );
  const hasReconnectionNeeded = detail.requires.services.some(
    (s) => s.status === "needs_reconnection",
  );
  const hasRequiredConfig = checkRequiredConfig(detail);
  const hasInputSchema = !!(
    detail.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0
  );
  const hasConfigSchema = !!(
    detail.config?.schema?.properties && Object.keys(detail.config.schema.properties).length > 0
  );

  const getServiceAuthMode = (svc: { provider: string; authMode?: string }): string | undefined => {
    if (svc.authMode) return svc.authMode;
    const pDef = providers?.find((p) => p.id === svc.provider);
    return pDef?.authMode === "api_key"
      ? "API_KEY"
      : pDef?.authMode === "oauth2"
        ? "OAUTH2"
        : undefined;
  };

  const isCredentialAuth = (provider: string): boolean => {
    const pDef = providers?.find((p) => p.id === provider);
    return !!pDef?.credentialSchema;
  };

  const value: FlowDetailContextValue = {
    detail,
    isOrgAdmin,
    packageId,
    executions,
    schedules,
    memories,
    providers,
    orgProxies,
    flowProxy,
    profileMap,
    profileId,
    pParam,
    runFlow,
    deleteFlow,
    deleteExecutions,
    connectMutation,
    apiKeyMutation,
    credentialsMutation,
    bindAdmin,
    unbindAdmin,
    disconnectMutation,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    deleteMemory,
    deleteAllMemories,
    setFlowProxy,
    configOpen,
    setConfigOpen,
    inputOpen,
    setInputOpen,
    scheduleOpen,
    setScheduleOpen,
    editingSchedule,
    setEditingSchedule,
    apiKeyService,
    setApiKeyService,
    customCredService,
    setCustomCredService,
    customCredSchema,
    allConnected,
    hasReconnectionNeeded,
    hasRequiredConfig,
    hasInputSchema,
    hasConfigSchema,
    getServiceAuthMode,
    isCredentialAuth,
  };

  return <FlowDetailContext.Provider value={value}>{children}</FlowDetailContext.Provider>;
}
