// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useStore } from "zustand";
import { useQueryClient } from "@tanstack/react-query";
import { appStore, getCurrentApplicationId } from "../stores/app-store";
import { useApplications } from "./use-applications";
import { useAutoSelect } from "./use-auto-select";
import { useAppConfig } from "./use-app-config";
import { getEnabledModuleQueryKeys } from "../lib/module-query-keys";

// Re-export non-hook accessor
export { getCurrentApplicationId };

/** Reactive hook — re-renders when the current application changes. */
export function useCurrentApplicationId(): string | null {
  return useStore(appStore, (s) => s.id);
}

/** Core app-scoped query key prefixes — invalidated on app switch. */
const CORE_APP_SCOPED_KEYS = [
  "packages",
  "agents",
  "agent-memories",
  "agent-model",
  "agent-proxy",
  "agent-provider-profiles",
  "runs",
  "run",
  "run-logs",
  "paginated-runs",
  "all-runs",
  "schedules",
  "schedule",
  "schedule-runs",
  "api-keys",
  "end-users",
  "providers",
  "available-providers",
  "user-connections",
  "profile-connections",
  "unread-count",
  "unread-counts-by-agent",
  "app-connection-profiles",
  "app-profile-bindings",
  "app-profile-agents",
  "version-detail",
  "package-versions",
  "version-info",
];

/**
 * Hook that returns a `switchApp` function.
 * Switches the current application and invalidates app-scoped caches.
 */
export function useAppSwitcher() {
  const queryClient = useQueryClient();
  const { features } = useAppConfig();

  const switchApp = useCallback(
    (appId: string) => {
      const current = appStore.getState().id;
      if (appId === current) return;

      appStore.getState().setId(appId);

      // Assemble the invalidation set: core keys + enabled module contributions.
      const moduleKeys = getEnabledModuleQueryKeys(features);
      const appScopedKeys = new Set<string>([...CORE_APP_SCOPED_KEYS, ...moduleKeys]);

      // Invalidate all app-scoped queries so they refetch with the new X-App-Id
      queryClient.removeQueries({
        predicate: (q) => {
          const key = q.queryKey[0];
          return typeof key === "string" && appScopedKeys.has(key);
        },
      });
    },
    [queryClient, features],
  );

  return { switchApp };
}

/**
 * Resolver — ensures `currentApplicationId` is always set.
 * If null, fetches applications and auto-selects the default one.
 * Must be called inside a component rendered within MainLayout.
 */
export function useApplicationResolver(): void {
  const currentAppId = useStore(appStore, (s) => s.id);
  const { data: applications } = useApplications();

  const setId = useCallback((id: string) => appStore.getState().setId(id), []);
  const findDefault = useCallback(
    (items: { id: string; isDefault: boolean }[]) => items.find((a) => a.isDefault),
    [],
  );

  useAutoSelect(applications, currentAppId, setId, findDefault);
}
