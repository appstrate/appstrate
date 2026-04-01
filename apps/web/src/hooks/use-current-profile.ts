import { useMemo } from "react";
import { useStore } from "zustand";
import { profileStore } from "../stores/profile-store";
import { useConnectionProfiles, useOrgProfiles } from "./use-connection-profiles";
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
 * Includes org profiles so selecting an org profile doesn't trigger a reset.
 */
export function useProfileAutoSelect() {
  const { data: userProfiles } = useConnectionProfiles();
  const { data: orgProfiles } = useOrgProfiles();
  const currentProfileId = useCurrentProfileId();

  // Merge user + org profiles into a single list for existence checking.
  // Only `id` and `isDefault` are needed by useAutoSelect.
  const allProfiles = useMemo(() => {
    if (!userProfiles) return undefined;
    const merged: Array<{ id: string; isDefault: boolean }> = [...userProfiles];
    if (orgProfiles) merged.push(...orgProfiles);
    return merged;
  }, [userProfiles, orgProfiles]);

  useAutoSelect(allProfiles, currentProfileId, setCurrentProfileId, (items) =>
    items.find((p) => p.isDefault),
  );
}

/** Spread helper: returns `{ profileId }` when set, empty object otherwise */
export function profileIdParam(profileId: string | null): { profileId?: string } {
  return profileId ? { profileId } : {};
}
