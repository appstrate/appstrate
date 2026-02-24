import { createPersistedStringStore } from "./create-persisted-string-store";

export const profileStore = createPersistedStringStore("appstrate_current_profile");
