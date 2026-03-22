import { createPersistedStringStore } from "./create-persisted-string-store";

export const appStore = createPersistedStringStore("appstrate_current_app");

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentApplicationId(): string | null {
  return appStore.getState().id;
}
