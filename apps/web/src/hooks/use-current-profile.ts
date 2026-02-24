import { useEffect, useSyncExternalStore } from "react";
import { useConnectionProfiles } from "./use-connection-profiles";

// ---------------------------------------------------------------------------
// Module-level store for current profile ID (useSyncExternalStore pattern)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "appstrate_current_profile";

let _currentProfileId: string | null = localStorage.getItem(STORAGE_KEY);
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): string | null {
  return _currentProfileId;
}

export function setCurrentProfileId(profileId: string | null) {
  _currentProfileId = profileId;
  if (profileId) {
    localStorage.setItem(STORAGE_KEY, profileId);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  for (const fn of listeners) fn();
}

// Sync with external localStorage changes (other tabs)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      _currentProfileId = e.newValue;
      for (const fn of listeners) fn();
    }
  });
}

// Reactive hook — re-renders when profile changes
export function useCurrentProfileId(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
