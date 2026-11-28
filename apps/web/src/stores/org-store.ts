// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { LOCAL_STORAGE_KEYS, createLocalStore, scalarCodec } from "@appstrate/ui/local-storage";
import { persistedScalar } from "./persisted-scalar-store";

export const orgStore = createStore(
  persistedScalar(
    createLocalStore(
      LOCAL_STORAGE_KEYS.currentOrg,
      scalarCodec<string | null>((raw) => raw),
    ),
    "id",
    "setId",
  ),
);

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentOrgId(): string | null {
  return orgStore.getState().id;
}
