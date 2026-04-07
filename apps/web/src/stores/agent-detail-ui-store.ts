// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

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
  apiKeyService: ApiKeyServiceState | null;
  setApiKeyService: (v: ApiKeyServiceState | null) => void;
  customCredService: CustomCredServiceState | null;
  setCustomCredService: (v: CustomCredServiceState | null) => void;
  reset: () => void;
}

const initialState = {
  apiKeyService: null as ApiKeyServiceState | null,
  customCredService: null as CustomCredServiceState | null,
};

export const useAgentDetailUI = create<AgentDetailUIState>()((set) => ({
  ...initialState,
  setApiKeyService: (apiKeyService) => set({ apiKeyService }),
  setCustomCredService: (customCredService) => set({ customCredService }),
  reset: () => set(initialState),
}));
