// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { api, apiFetch, buildQs, uploadFormData } from "../api";
import { PACKAGE_CONFIG, type PackageType } from "./use-packages";
import { packageDetailPath } from "../lib/package-paths";
import { invalidateConnectionRelated } from "./invalidation";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export function onMutationError(err: Error) {
  toast.error(i18n.t("error.prefix", { message: err.message }));
}

export function useSaveConfig(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      return api(`/agents/${packageId}/config`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
    onError: onMutationError,
  });
}

export interface RunAgentParams {
  input?: Record<string, unknown>;
  version?: string;
}

export function useRunAgent(packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (params?: RunAgentParams) => {
      const { input, version } = params ?? {};
      const qs = buildQs({ version });
      const body: Record<string, unknown> = {};
      if (input !== undefined) body.input = input;
      return api<{ runId: string }>(`/agents/${packageId}/run${qs}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      navigate(`/agents/${packageId}/runs/${data.runId}`);
    },
    onError: onMutationError,
  });
}

export function useConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: string | { provider: string; scopes?: string[]; connectionProfileId?: string },
    ) => {
      const provider = typeof params === "string" ? params : params.provider;
      const scopes = typeof params === "string" ? undefined : params.scopes;
      const connectionProfileId =
        typeof params === "string" ? undefined : params.connectionProfileId;

      const body: Record<string, unknown> = {};
      if (scopes) body.scopes = scopes;
      if (connectionProfileId) body.connectionProfileId = connectionProfileId;

      const session = await apiFetch<{ authUrl: string }>(`/api/connections/connect/${provider}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const popup = window.open(session.authUrl, "oauth", "width=600,height=700");
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
      invalidateConnectionRelated(qc);
      toast.success(i18n.t("settings:providers.connectSuccess"));
    },
    onError: onMutationError,
  });
}

export function useConnectApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      apiKey,
      connectionProfileId,
    }: {
      provider: string;
      apiKey: string;
      connectionProfileId?: string;
    }) => {
      return apiFetch(`/api/connections/connect/${provider}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey, ...(connectionProfileId ? { connectionProfileId } : {}) }),
      });
    },
    onSuccess: () => {
      invalidateConnectionRelated(qc);
      toast.success(i18n.t("settings:providers.connectSuccess"));
    },
    onError: onMutationError,
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: string | { provider: string; connectionProfileId?: string; connectionId?: string },
    ) => {
      const provider = typeof params === "string" ? params : params.provider;
      const connectionProfileId =
        typeof params === "string" ? undefined : params.connectionProfileId;
      const connectionId = typeof params === "string" ? undefined : params.connectionId;
      const qs = buildQs({
        connectionId,
        ...(!connectionId ? { connectionProfileId } : {}),
      });
      return apiFetch(`/api/connections/${provider}${qs}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateConnectionRelated(qc),
    onError: onMutationError,
  });
}

export function useDeleteAllConnections() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/app-profiles/connections", { method: "DELETE" }),
    onSuccess: () => {
      invalidateConnectionRelated(qc);
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
    },
    onError: onMutationError,
  });
}

export function useImportPackage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({ file, force }: { file: File; force?: boolean }) => {
      const fd = new FormData();
      fd.append("file", file);
      // Multi-package bundles route to a different endpoint; the
      // single-package import endpoint can't decode them. Detect by
      // extension so users can drag both kinds into the same modal.
      if (file.name.toLowerCase().endsWith(".afps-bundle")) {
        const res = await uploadFormData<{
          rootPackageId: string;
          rootVersion: string;
        }>("/packages/import-bundle", fd);
        return { packageId: res.rootPackageId, type: "agent" as const };
      }
      const qs = force ? "?force=true" : "";
      return uploadFormData<{ packageId: string; type: string }>(`/packages/import${qs}`, fd);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      navigate(`/${data.type === "agent" ? "agent" : data.type}s/${data.packageId}`);
    },
    onError: onMutationError,
  });
}

export function useImportFromGithub() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (url: string) => {
      return api<{ packageId: string; type: string }>("/packages/import-github", {
        method: "POST",
        body: JSON.stringify({ url }),
        headers: { "Content-Type": "application/json" },
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      navigate(`/${data.type === "agent" ? "agent" : data.type}s/${data.packageId}`);
    },
    onError: onMutationError,
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      return api(`/runs/${runId}/cancel`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
    },
    onError: onMutationError,
  });
}

export function useConnectCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      credentials,
      connectionProfileId,
    }: {
      provider: string;
      credentials: Record<string, string>;
      connectionProfileId?: string;
    }) => {
      return apiFetch(`/api/connections/connect/${provider}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          credentials,
          ...(connectionProfileId ? { connectionProfileId } : {}),
        }),
      });
    },
    onSuccess: () => {
      invalidateConnectionRelated(qc);
      toast.success(i18n.t("settings:providers.connectSuccess"));
    },
    onError: onMutationError,
  });
}

export function useDeleteAgentRuns(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ deleted: number }>(`/agents/${packageId}/runs`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (packageId: string) => {
      await api(`/packages/agents/${packageId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      navigate("/");
    },
    onError: onMutationError,
  });
}

// --- Memory mutations (unified persistence — ADR-011) ---

export function useDeleteMemory(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (memoryId: number) => {
      return api(`/agents/${packageId}/persistence/memories/${memoryId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAllMemories(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ memoriesDeleted: number; checkpointDeleted: boolean }>(
        `/agents/${packageId}/persistence?kind=memory`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}

// --- Package (skill/tool) create/update mutations ---

export function useCreatePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (body: {
      id?: string;
      manifest: Record<string, unknown>;
      content: string;
      sourceCode?: string;
    }) => {
      return api<{ packageId: string }>(`/packages/${cfg.path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (type === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
      if (type === "provider") invalidateProviderQueries(qc);
      if (data.packageId) {
        navigate(packageDetailPath(type, data.packageId));
      }
    },
    onError: onMutationError,
  });
}

export function useUpdatePackage(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      sourceCode?: string;
      lockVersion: number;
    }) => {
      return api<{ lockVersion: number }>(`/packages/${cfg.path}/${packageId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (type === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
      if (type === "provider") invalidateProviderQueries(qc);
      qc.invalidateQueries({ queryKey: ["version-info"] });
      navigate(packageDetailPath(type, packageId));
    },
    onError: onMutationError,
  });
}

// --- Provider mutations ---

function invalidateProviderQueries(qc: ReturnType<typeof useQueryClient>) {
  const cfg = PACKAGE_CONFIG.provider;
  qc.invalidateQueries({ queryKey: ["providers"] });
  qc.invalidateQueries({ queryKey: ["packages", cfg.path] });
  qc.invalidateQueries({ queryKey: ["version-info"] });
  qc.invalidateQueries({ queryKey: ["available-providers"] });
}

export function useConfigureProviderCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      providerId,
      credentials,
      enabled,
      invalidateConnections,
    }: {
      providerId: string;
      credentials?: Record<string, string>;
      enabled?: boolean;
      invalidateConnections?: boolean;
    }) => {
      return api(`/providers/credentials/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ credentials, enabled, invalidateConnections }),
      });
    },
    onSuccess: () => {
      invalidateProviderQueries(qc);
      toast.success(i18n.t("settings:providers.credentialsSaved"));
    },
    onError: onMutationError,
  });
}

export function useDeleteProviderCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => {
      return api(`/providers/credentials/${providerId}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateProviderQueries(qc),
    onError: onMutationError,
  });
}
