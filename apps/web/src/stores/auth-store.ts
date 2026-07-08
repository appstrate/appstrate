// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import type { UserProfile } from "@appstrate/shared-types";

/**
 * `GET /api/profile` does not serialize the DB row's `createdAt`/`updatedAt`
 * (and the SPA never reads them), so the store holds only the fields the
 * server actually returns — no fabricated timestamps.
 */
export type AuthProfile = Omit<UserProfile, "createdAt" | "updatedAt">;

interface AuthState {
  user: { id: string; email: string; emailVerified: boolean; name?: string } | null;
  profile: AuthProfile | null;
  loading: boolean;
}

export const authStore = createStore<AuthState>()(() => ({
  user: null,
  profile: null,
  loading: true,
}));
