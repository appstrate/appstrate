import { createStore } from "zustand/vanilla";
import type { Profile } from "@appstrate/shared-types";

interface AuthState {
  user: { id: string; email: string; name?: string } | null;
  profile: Profile | null;
  loading: boolean;
}

export const authStore = createStore<AuthState>()(() => ({
  user: null,
  profile: null,
  loading: true,
}));
