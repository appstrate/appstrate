// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";
import { $api } from "../api/client";
import { authStore } from "../stores/auth-store";

export function useUpdateLanguage() {
  return $api.useMutation("patch", "/api/profile", {
    onSuccess: (data) => {
      i18n.changeLanguage(data.language);
    },
  });
}

export function useUpdateDisplayName() {
  return $api.useMutation("patch", "/api/profile", {
    onSuccess: (data) => {
      const state = authStore.getState();
      if (state.profile) {
        authStore.setState({
          profile: { ...state.profile, displayName: data.displayName ?? null },
        });
      }
    },
  });
}
