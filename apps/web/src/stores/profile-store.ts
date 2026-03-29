import { createPersistedStringStore } from "./create-persisted-string-store";

export const profileStore = createPersistedStringStore("appstrate_current_profile");
export const orgProfileStore = createPersistedStringStore("appstrate_current_org_profile");
