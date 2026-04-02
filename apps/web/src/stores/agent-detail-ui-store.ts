// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type { Schedule } from "@appstrate/shared-types";

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

interface AgentDetailUIState {
  scheduleOpen: boolean;
  setScheduleOpen: (v: boolean) => void;
  editingSchedule: Schedule | null;
  setEditingSchedule: (s: Schedule | null) => void;
  apiKeyService: ApiKeyServiceState | null;
  setApiKeyService: (v: ApiKeyServiceState | null) => void;
  customCredService: CustomCredServiceState | null;
  setCustomCredService: (v: CustomCredServiceState | null) => void;
  reset: () => void;
}

const initialState = {
  scheduleOpen: false,
  editingSchedule: null as Schedule | null,
  apiKeyService: null as ApiKeyServiceState | null,
  customCredService: null as CustomCredServiceState | null,
};

export const useAgentDetailUI = create<AgentDetailUIState>()((set) => ({
  ...initialState,
  setScheduleOpen: (scheduleOpen) => set({ scheduleOpen }),
  setEditingSchedule: (editingSchedule) => set({ editingSchedule }),
  setApiKeyService: (apiKeyService) => set({ apiKeyService }),
  setCustomCredService: (customCredService) => set({ customCredService }),
  reset: () => set(initialState),
}));
