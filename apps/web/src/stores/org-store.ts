// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { persistedScalar } from "./persisted-scalar-store";

export const orgStore = createStore(
  persistedScalar("appstrate_current_org", (raw) => raw, "id", "setId"),
);

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentOrgId(): string | null {
  return orgStore.getState().id;
}
