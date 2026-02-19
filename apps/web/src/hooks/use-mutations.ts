import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, apiFetch, uploadFormData, apiBlob } from "../api";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function onMutationError(err: Error) {
  alert(`Erreur : ${err.message}`);
}

function invalidateFlowQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["flows"] });
  qc.invalidateQueries({ queryKey: ["flow"] });
}

export function useSaveConfig(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      return api(`/flows/${flowId}/config`, {
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

export function useRunFlow(flowId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (params?: {
      input?: Record<string, unknown>;
      files?: Record<string, File[]>;
    }) => {
      const { input, files } = params ?? {};

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
        return uploadFormData<{ executionId: string }>(`/flows/${flowId}/run`, fd);
      }

      // JSON mode (existing behavior)
      return api<{ executionId: string }>(`/flows/${flowId}/run`, {
        method: "POST",
        body: JSON.stringify(input ? { input } : {}),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["executions"] });
      navigate(`/flows/${flowId}/executions/${data.executionId}`);
    },
    onError: onMutationError,
  });
}

function invalidateServiceRelated(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["services"] });
  // Invalidate all flow detail queries (service status may have changed)
  qc.invalidateQueries({ queryKey: ["flow"] });
  qc.invalidateQueries({ queryKey: ["flows"] });
}

export function useConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      const session = await apiFetch<{ connectLink: string }>(`/auth/connect/${provider}`, {
        method: "POST",
      });
      const popup = window.open(session.connectLink, "oauth", "width=600,height=700");
      if (!popup) {
        throw new Error("Popup bloque par le navigateur. Autorisez les popups pour ce site.");
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error("Timeout de connexion OAuth"));
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
    mutationFn: async ({ provider, apiKey }: { provider: string; apiKey: string }) => {
      return apiFetch(`/auth/connect/${provider}/api-key`, {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      return apiFetch(`/auth/connections/${provider}`, { method: "DELETE" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useBindAdminService(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId: string) => {
      return api(`/flows/${flowId}/services/${serviceId}/bind`, { method: "POST" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    // No onError — handled by the component (may open connect flow before retrying)
  });
}

export function useUnbindAdminService(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (serviceId: string) => {
      return api(`/flows/${flowId}/services/${serviceId}/bind`, { method: "DELETE" });
    },
    onSuccess: () => invalidateServiceRelated(qc),
    onError: onMutationError,
  });
}

export function useImportFlow() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return uploadFormData<{ flowId: string }>("/flows/import", fd);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      navigate(`/flows/${data.flowId}`);
    },
    onError: onMutationError,
  });
}

export function useCreateFlow() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      prompt: string;
      skillIds?: string[];
      extensionIds?: string[];
    }) => {
      return api<{ flowId: string }>("/flows", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      navigate(`/flows/${data.flowId}`);
    },
    onError: onMutationError,
  });
}

export function useUpdateFlow(flowId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      prompt: string;
      updatedAt: string;
      skillIds?: string[];
      extensionIds?: string[];
    }) => {
      return api<{ flowId: string; updatedAt: string }>(`/flows/${flowId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      invalidateFlowQueries(qc);
      navigate(`/flows/${flowId}`);
    },
    onError: onMutationError,
  });
}

export function useUploadPackage(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, updatedAt }: { file: File; updatedAt: string }) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("updatedAt", updatedAt);
      return uploadFormData<{ flowId: string; updatedAt: string }>(
        `/flows/${flowId}/package`,
        fd,
        "PUT",
      );
    },
    onSuccess: () => invalidateFlowQueries(qc),
    onError: onMutationError,
  });
}

export async function downloadPackage(flowId: string): Promise<void> {
  const blob = await apiBlob(`/flows/${flowId}/package`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${flowId}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

export function useDeleteFlow() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (flowId: string) => {
      await api(`/flows/${flowId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      navigate("/");
    },
    onError: onMutationError,
  });
}
