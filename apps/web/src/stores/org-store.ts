// SPDX-License-Identifier: Apache-2.0

import { createPersistedStringStore } from "./create-persisted-string-store";

export const orgStore = createPersistedStringStore("appstrate_current_org");

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentOrgId(): string | null {
  return orgStore.getState().id;
}
