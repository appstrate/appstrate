import { useEffect } from "react";
import { useStore } from "zustand";
import { profileStore } from "../stores/profile-store";
import { useConnectionProfiles } from "./use-connection-profiles";

export function setCurrentProfileId(profileId: string | null) {
  profileStore.getState().setId(profileId);
}

// Reactive hook — re-renders when profile changes
export function useCurrentProfileId(): string | null {
  return useStore(profileStore, (s) => s.id);
}

/**
 * Auto-selects default profile when profiles load and nothing is stored
 * (or stored profile no longer exists). Call once near the app root.
 */
export function useProfileAutoSelect() {
  const { data: profiles } = useConnectionProfiles();
  const currentProfileId = useCurrentProfileId();

  useEffect(() => {
    if (!profiles || profiles.length === 0) return;
    const storedExists = currentProfileId && profiles.some((p) => p.id === currentProfileId);
    if (!storedExists) {
      const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
      setCurrentProfileId(defaultProfile.id);
    }
  }, [profiles, currentProfileId]);
}

/** Spread helper: returns `{ profileId }` when set, empty object otherwise */
export function profileIdParam(profileId: string | null): { profileId?: string } {
  return profileId ? { profileId } : {};
}
