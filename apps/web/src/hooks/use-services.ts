import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api";
import type { Integration } from "@openflows/shared-types";

export function useServices() {
  return useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const data = await apiFetch<{ integrations: Integration[] }>("/auth/integrations");
      return data.integrations;
    },
  });
}
