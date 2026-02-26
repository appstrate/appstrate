import { useMutation } from "@tanstack/react-query";
import i18n from "../i18n";
import { api } from "../api";
import { authStore } from "../stores/auth-store";

export function useUpdateLanguage() {
  return useMutation({
    mutationFn: async (language: string) => {
      await api("/profile", {
        method: "PATCH",
        body: JSON.stringify({ language }),
      });
      return language;
    },
    onSuccess: (language) => {
      i18n.changeLanguage(language);
    },
  });
}

export function useUpdateDisplayName() {
  return useMutation({
    mutationFn: async (displayName: string) => {
      await api("/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      });
      return displayName;
    },
    onSuccess: (displayName) => {
      const state = authStore.getState();
      if (state.profile) {
        authStore.setState({ profile: { ...state.profile, displayName } });
      }
    },
  });
}
