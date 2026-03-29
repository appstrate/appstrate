import { useStore } from "zustand";
import { profileStore, orgProfileStore } from "../stores/profile-store";
import { useConnectionProfiles, useOrgProfiles } from "./use-connection-profiles";
import { useAutoSelect } from "./use-auto-select";

// ─── User Profile ────────────────────────────────────────

export function setCurrentProfileId(profileId: string | null) {
  profileStore.getState().setId(profileId);
}

export function useCurrentProfileId(): string | null {
  return useStore(profileStore, (s) => s.id);
}

/**
 * Auto-selects default user profile when profiles load and nothing is stored
 * (or stored profile no longer exists). Call once near the app root.
 */
export function useProfileAutoSelect() {
  const { data: profiles } = useConnectionProfiles();
  const currentProfileId = useCurrentProfileId();

  useAutoSelect(profiles, currentProfileId, setCurrentProfileId, (items) =>
    items.find((p) => p.isDefault),
  );
}

/** Spread helper: returns `{ profileId }` when set, empty object otherwise */
export function profileIdParam(profileId: string | null): { profileId?: string } {
  return profileId ? { profileId } : {};
}

// ─── Org Profile ─────────────────────────────────────────

export function setCurrentOrgProfileId(orgProfileId: string | null) {
  orgProfileStore.getState().setId(orgProfileId);
}

export function useCurrentOrgProfileId(): string | null {
  return useStore(orgProfileStore, (s) => s.id);
}

/**
 * Clears the org profile selection if the stored ID no longer exists
 * in the org profiles list. Does NOT auto-select — org profile is opt-in.
 */
export function useOrgProfileAutoCleanup() {
  const { data: orgProfiles } = useOrgProfiles();
  const currentOrgProfileId = useCurrentOrgProfileId();

  // If org profiles loaded and current selection doesn't exist, clear it
  if (orgProfiles && currentOrgProfileId) {
    const exists = orgProfiles.some((p) => p.id === currentOrgProfileId);
    if (!exists) setCurrentOrgProfileId(null);
  }
}
