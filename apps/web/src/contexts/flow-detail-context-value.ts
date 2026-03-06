import { createContext } from "react";
import type { FlowDetail, JSONSchemaObject, Schedule } from "@appstrate/shared-types";
import type {
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
import type {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import type { useExecutions } from "../hooks/use-executions";
import type { useFlowMemories } from "../hooks/use-memories";
import type { useProviders } from "../hooks/use-providers";
import type { useProxies, useFlowProxy, useSetFlowProxy } from "../hooks/use-proxies";
import type { profileIdParam } from "../hooks/use-current-profile";

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

export interface FlowDetailContextValue {
  // Data
  detail: FlowDetail;
  isOrgAdmin: boolean;
  packageId: string;
  executions: ReturnType<typeof useExecutions>["data"];
  schedules: ReturnType<typeof useSchedules>["data"];
  memories: ReturnType<typeof useFlowMemories>["data"];
  providers: ReturnType<typeof useProviders>["data"];
  orgProxies: ReturnType<typeof useProxies>["data"];
  flowProxy: ReturnType<typeof useFlowProxy>["data"];
  profileMap: Map<string, string | undefined>;
  profileId: string | null;
  pParam: ReturnType<typeof profileIdParam>;

  // Mutations
  deleteFlow: ReturnType<typeof useDeleteFlow>;
  deleteExecutions: ReturnType<typeof useDeleteFlowExecutions>;
  connectMutation: ReturnType<typeof useConnect>;
  apiKeyMutation: ReturnType<typeof useConnectApiKey>;
  credentialsMutation: ReturnType<typeof useConnectCredentials>;
  bindAdmin: ReturnType<typeof useBindAdminService>;
  unbindAdmin: ReturnType<typeof useUnbindAdminService>;
  disconnectMutation: ReturnType<typeof useDisconnect>;
  createSchedule: ReturnType<typeof useCreateSchedule>;
  updateSchedule: ReturnType<typeof useUpdateSchedule>;
  deleteSchedule: ReturnType<typeof useDeleteSchedule>;
  deleteMemory: ReturnType<typeof useDeleteMemory>;
  deleteAllMemories: ReturnType<typeof useDeleteAllMemories>;
  setFlowProxy: ReturnType<typeof useSetFlowProxy>;

  // Modal states
  configOpen: boolean;
  setConfigOpen: (v: boolean) => void;
  scheduleOpen: boolean;
  setScheduleOpen: (v: boolean) => void;
  editingSchedule: Schedule | null;
  setEditingSchedule: (s: Schedule | null) => void;
  apiKeyService: ApiKeyServiceState | null;
  setApiKeyService: (v: ApiKeyServiceState | null) => void;
  customCredService: CustomCredServiceState | null;
  setCustomCredService: (v: CustomCredServiceState | null) => void;

  // Derived helpers
  customCredSchema: JSONSchemaObject | undefined;
  allConnected: boolean;
  hasReconnectionNeeded: boolean;
  hasRequiredConfig: boolean;
  hasConfigSchema: boolean;
  getServiceAuthMode: (svc: { provider: string; authMode?: string }) => string | undefined;
  isCredentialAuth: (provider: string) => boolean;
}

export const FlowDetailContext = createContext<FlowDetailContextValue | null>(null);
