// SPDX-License-Identifier: Apache-2.0

import { createPersistedStringStore } from "./create-persisted-string-store";

export const spaceStore = createPersistedStringStore("appstrate_current_space");

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentSpaceId(): string | null {
  return spaceStore.getState().id;
}
