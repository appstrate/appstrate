import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import i18n from "../i18n";
import { api, apiFetch, uploadFormData } from "../api";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function onMutationError(err: Error) {
  alert(i18n.t("error.prefix", { message: err.message }));
}

function invalidateFlowQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["flows"] });
  qc.invalidateQueries({ queryKey: ["version-info"] });
  return qc.invalidateQueries({ queryKey: ["flow"] });
}

export function useSaveConfig(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      return api(`/flows/${packageId}/config`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow"] });
    },
    onError: onMutationError,
  });
}

export function useRunFlow(packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (params?: {
      input?: Record<string, unknown>;
      files?: Record<string, File[]>;
      profileId?: string;
      version?: string;
    }) => {
      const { input, files, profileId, version } = params ?? {};
      const qsParts: string[] = [];
      if (profileId) qsParts.push(`profileId=${encodeURIComponent(profileId)}`);
      if (version) qsParts.push(`version=${encodeURIComponent(version)}`);
      const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";

      // If files are present, use FormData
      const hasFiles = files && Object.values(files).some((f) => f.length > 0);
      if (hasFiles) {
        const fd = new FormData();
        if (input && Object.keys(input).length > 0) {
          fd.append("input", JSON.stringify(input));
        }
        for (const [key, fileList] of Object.entries(files!)) {
          for (const file of fileList) {
            fd.append(key, file);
          }
        }
        return uploadFormData<{ executionId: string }>(`/flows/${packageId}/run${qs}`, fd);
      }

      // JSON mode (existing behavior)
      return api<{ executionId: string }>(`/flows/${packageId}/run${qs}`, {
        method: "POST",
        body: JSON.stringify(input ? { input } : {}),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["executions"] });
      navigate(`/flows/${packageId}/executions/${data.executionId}`);
    },
    onError: onMutationError,
  });
}

function invalidateServiceRelated(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["services"] });
  qc.invalidateQueries({ queryKey: ["user-connections"] });
  // Invalidate all flow detail queries (service status may have changed)
  qc.invalidateQueries({ queryKey: ["flow"] });
  qc.invalidateQueries({ queryKey: ["flows"] });
}

export function useConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: string | { provider: string; scopes?: string[]; profileId?: string },
    ) => {
      const provider = typeof params === "string" ? params : params.provider;
      const scopes = typeof params === "string" ? undefined : params.scopes;
      const profileId = typeof params === "string" ? undefined : params.profileId;

      const body: Record<string, unknown> = {};
      if (scopes) body.scopes = scopes;
      if (profileId) body.profileId = profileId;

      const session = await apiFetch<{ authUrl: string }>(`/auth/connect/${provider}`, {
        method: "POST",
        ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {}),
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
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useConnectApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      apiKey,
      profileId,
    }: {
      provider: string;
      apiKey: string;
      profileId?: string;
    }) => {
      return apiFetch(`/auth/connect/${provider}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey, ...(profileId ? { profileId } : {}) }),
      });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: string | { provider: string; profileId?: string; connectionId?: string },
    ) => {
      const provider = typeof params === "string" ? params : params.provider;
      const profileId = typeof params === "string" ? undefined : params.profileId;
      const connectionId = typeof params === "string" ? undefined : params.connectionId;
      const qsParts: string[] = [];
      if (connectionId) qsParts.push(`connectionId=${connectionId}`);
      else if (profileId) qsParts.push(`profileId=${profileId}`);
      const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
      return apiFetch(`/auth/connections/${provider}${qs}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useDeleteAllConnections() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/connection-profiles/connections", { method: "DELETE" }),
    onSuccess: () => {
      invalidateServiceRelated(qc);
      qc.invalidateQueries({ queryKey: ["connection-profiles"] });
    },
    onError: onMutationError,
  });
}

export function useBindAdminService(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId: string) => {
      return api(`/flows/${packageId}/services/${serviceId}/bind`, { method: "POST" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    // No onError — handled by the component (may open connect flow before retrying)
  });
}

export function useUnbindAdminService(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId: string) => {
      return api(`/flows/${packageId}/services/${serviceId}/bind`, { method: "DELETE" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
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
      const qs = force ? "?force=true" : "";
      return uploadFormData<{ packageId: string; type: string }>(`/packages/import${qs}`, fd);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (data.type === "flow") {
        navigate(`/flows/${data.packageId}`);
      }
    },
  });
}

export function useCreateFlow() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: { manifest: Record<string, unknown>; prompt: string }) => {
      return api<{ packageId: string; lockVersion: number }>("/packages/flows", {
        method: "POST",
        body: JSON.stringify({ manifest: body.manifest, content: body.prompt }),
      });
    },
    onSuccess: async (data) => {
      await invalidateFlowQueries(qc);
      navigate(`/flows/${data.packageId}`);
    },
    onError: onMutationError,
  });
}

export function useUpdateFlow(packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      prompt: string;
      lockVersion: number;
    }) => {
      return api<{ flow: { id: string }; lockVersion: number }>(`/packages/flows/${packageId}`, {
        method: "PUT",
        body: JSON.stringify({
          manifest: body.manifest,
          content: body.prompt,
          lockVersion: body.lockVersion,
        }),
      });
    },
    onSuccess: async () => {
      await invalidateFlowQueries(qc);
      navigate(`/flows/${packageId}`);
    },
    onError: onMutationError,
  });
}

export function useCancelExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (execId: string) => {
      return api(`/executions/${execId}/cancel`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["execution"] });
      qc.invalidateQueries({ queryKey: ["executions"] });
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
      profileId,
    }: {
      provider: string;
      credentials: Record<string, string>;
      profileId?: string;
    }) => {
      return apiFetch(`/auth/connect/${provider}/credentials`, {
        method: "POST",
        body: JSON.stringify({ credentials, ...(profileId ? { profileId } : {}) }),
      });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useDeleteFlowExecutions(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ deleted: number }>(`/flows/${packageId}/executions`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["executions"] });
      qc.invalidateQueries({ queryKey: ["flow"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteFlow() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (packageId: string) => {
      await api(`/packages/flows/${packageId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      navigate("/");
    },
    onError: onMutationError,
  });
}

// --- Memory mutations ---

export function useDeleteMemory(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (memoryId: number) => {
      return api(`/flows/${packageId}/memories/${memoryId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-memories"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAllMemories(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ deleted: number }>(`/flows/${packageId}/memories`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-memories"] });
    },
    onError: onMutationError,
  });
}

// --- Package (skill/extension) create/update mutations ---

export function useCreatePackage(type: "skill" | "extension" | "provider") {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = type === "skill" ? "skills" : type === "extension" ? "extensions" : "providers";
  return useMutation({
    mutationFn: async (body: {
      id: string;
      manifest: Record<string, unknown>;
      content: string;
    }) => {
      return api<{ [key: string]: { id: string; name: string; description: string } }>(
        `/packages/${path}`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["packages", path] });
      const result = data[type];
      if (result?.id) {
        navigate(`/${type}s/${result.id}`);
      }
    },
    onError: onMutationError,
  });
}

export function useUpdatePackage(type: "skill" | "extension" | "provider", packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = type === "skill" ? "skills" : type === "extension" ? "extensions" : "providers";
  const detailKey = type;
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      lockVersion: number;
    }) => {
      return api<{ lockVersion: number }>(`/packages/${path}/${packageId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", path] });
      qc.invalidateQueries({ queryKey: ["packages", detailKey] });
      qc.invalidateQueries({ queryKey: ["version-info"] });
      navigate(`/${type}s/${packageId}`);
    },
    onError: onMutationError,
  });
}

// --- Provider mutations ---

function invalidateProviderQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["providers"] });
  qc.invalidateQueries({ queryKey: ["packages", "providers"] });
  qc.invalidateQueries({ queryKey: ["packages", "provider"] });
  qc.invalidateQueries({ queryKey: ["version-info"] });
  qc.invalidateQueries({ queryKey: ["services"] });
}

export function useConfigureProviderCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      providerId,
      credentials,
      enabled,
    }: {
      providerId: string;
      credentials?: Record<string, string>;
      enabled?: boolean;
    }) => {
      return api(`/providers/credentials/${providerId}`, {
        method: "PUT",
        body: JSON.stringify({ credentials, enabled }),
      });
    },
    onSuccess: () => invalidateProviderQueries(qc),
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

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      return api<{ id: string }>("/providers", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateProviderQueries(qc),
    onError: onMutationError,
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      return api(`/providers/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => invalidateProviderQueries(qc),
    onError: onMutationError,
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/providers/${id}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateProviderQueries(qc),
    onError: onMutationError,
  });
}
