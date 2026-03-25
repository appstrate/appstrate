import { useStore } from "zustand";
import { appStore, getCurrentApplicationId } from "../stores/app-store";
import { useApplications } from "./use-applications";
import { useAutoSelect } from "./use-auto-select";

// Re-export non-hook accessor
export { getCurrentApplicationId };

/** Reactive hook — re-renders when the current application changes. */
export function useCurrentApplicationId(): string | null {
  return useStore(appStore, (s) => s.id);
}

/** Set the current application ID in the store. */
export function setCurrentApplicationId(id: string | null): void {
  appStore.getState().setId(id);
}

/**
 * Resolver — ensures `currentApplicationId` is always set.
 * If null, fetches applications and auto-selects the default one.
 * Must be called inside a component rendered within MainLayout.
 */
export function useApplicationResolver(): void {
  const currentAppId = useStore(appStore, (s) => s.id);
  const { data: applications } = useApplications();

  useAutoSelect(
    applications,
    currentAppId,
    (id) => appStore.getState().setId(id),
    (items) => items.find((a) => a.isDefault),
  );
}
