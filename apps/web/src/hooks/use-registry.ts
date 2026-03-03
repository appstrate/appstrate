import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n from "../i18n";
import { api, ApiError } from "../api";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function onMutationError(err: Error) {
  alert(i18n.t("error.prefix", { message: err.message }));
}

export function useRegistryStatus() {
  return useQuery({
    queryKey: ["registry", "status"],
    queryFn: () =>
      api<{ connected: boolean; username?: string; expiresAt?: string; expired?: boolean }>(
        "/registry/status",
      ),
    staleTime: 30_000,
  });
}

export function useRegistryConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const session = await api<{ authUrl: string; state: string }>("/registry/connect", {
        method: "POST",
      });
      const popup = window.open(session.authUrl, "registry-oauth", "width=600,height=700");
      if (!popup) {
        throw new Error(i18n.t("error.popupBlocked"));
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(i18n.t("error.oauthTimeout")));
        }, OAUTH_TIMEOUT_MS);
        const interval = setInterval(() => {
          if (popup.closed) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry"] });
    },
    onError: onMutationError,
  });
}

export function useRegistryDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/registry/disconnect", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry"] });
    },
    onError: onMutationError,
  });
}

export function useRegistryScopes() {
  const { data: status } = useRegistryStatus();
  return useQuery({
    queryKey: ["registry", "scopes"],
    queryFn: () =>
      api<{ scopes: { name: string; ownerId: string }[] }>("/registry/scopes").then(
        (r) => r.scopes,
      ),
    enabled: !!status?.connected,
  });
}

export function useClaimScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api("/registry/scopes", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", "scopes"] });
    },
    onError: onMutationError,
  });
}

export function usePublishPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ packageId }: { packageId: string }) =>
      api<{ scope: string; name: string; version: string }>(`/packages/${packageId}/publish`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["registry"] });
    },
    onError: (err: Error) => {
      if (err instanceof ApiError) {
        const key = `publish.error.${err.code}`;
        const translated = i18n.t(key, { ns: "flows", defaultValue: "" });
        const message =
          translated || i18n.t("publish.error.generic", { ns: "flows", message: err.message });
        alert(message);
        return;
      }
      onMutationError(err);
    },
  });
}
