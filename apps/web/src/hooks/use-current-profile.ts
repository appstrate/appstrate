import { useStore } from "zustand";
import { profileStore } from "../stores/profile-store";
import { useConnectionProfiles } from "./use-connection-profiles";
import { useAutoSelect } from "./use-auto-select";

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

  useAutoSelect(profiles, currentProfileId, setCurrentProfileId, (items) =>
    items.find((p) => p.isDefault),
  );
}

/** Spread helper: returns `{ profileId }` when set, empty object otherwise */
export function profileIdParam(profileId: string | null): { profileId?: string } {
  return profileId ? { profileId } : {};
}
