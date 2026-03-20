import { useQuery } from "@tanstack/react-query";

export interface AppConfig {
  socialProviders: string[];
  platform: "oss" | "cloud";
  features: {
    billing: boolean;
    models: boolean;
    providerKeys: boolean;
  };
}

const DEFAULT_CONFIG: AppConfig = {
  socialProviders: [],
  platform: "oss",
  features: { billing: false, models: true, providerKeys: true },
};

export function useAppConfig(): AppConfig {
  const { data } = useQuery({
    queryKey: ["app-config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      if (!res.ok) return DEFAULT_CONFIG;
      return res.json() as Promise<AppConfig>;
    },
    staleTime: Infinity,
  });

  return data ?? DEFAULT_CONFIG;
}
