import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import i18n from "../i18n";
import { api } from "../api";
import { useOrg } from "./use-org";

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
    mutationFn: ({
      packageId,
      scope,
      name,
      version,
    }: {
      packageId: string;
      scope?: string;
      name?: string;
      version: string;
    }) =>
      api<{ scope: string; name: string; version: string }>(`/packages/${packageId}/publish`, {
        method: "POST",
        body: JSON.stringify({ scope, name, version }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["registry"] });
    },
    onError: onMutationError,
  });
}

export function usePublishInfo(packageId: string | undefined) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  return useQuery({
    queryKey: ["publish-info", orgId, packageId],
    queryFn: () =>
      api<{
        manifest: Record<string, unknown>;
        registryScope: string | null;
        registryName: string | null;
        lastPublishedVersion: string | null;
        lastPublishedAt: string | null;
        registryScopes: { name: string; ownerId: string }[];
      }>(`/packages/${packageId}/publish-info`),
    enabled: !!packageId && !!orgId,
  });
}
