import { useMutation } from "@tanstack/react-query";
import i18n from "../i18n";
import { api } from "../api";

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
