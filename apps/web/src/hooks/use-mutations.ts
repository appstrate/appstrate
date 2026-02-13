import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, apiFetch, uploadFormData } from "../api";

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

function onMutationError(err: Error) {
  alert(`Erreur : ${err.message}`);
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
      qc.invalidateQueries({ queryKey: ["flow", flowId] });
    },
    onError: onMutationError,
  });
}

export function useResetState(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api(`/flows/${flowId}/state`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow", flowId] });
    },
    onError: onMutationError,
  });
}

export function useRunFlow(flowId: string) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (input?: Record<string, unknown>) => {
      return api<{ executionId: string }>(`/flows/${flowId}/run`, {
        method: "POST",
        body: JSON.stringify({ stream: false, ...(input ? { input } : {}) }),
      });
    },
    onSuccess: (data) => {
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
      skills?: { id: string; description: string; content: string }[];
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
  });
}

export function useUpdateFlow(flowId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      prompt: string;
      skills?: { id: string; description: string; content: string }[];
      updatedAt: string;
    }) => {
      return api<{ flowId: string; updatedAt: string }>(`/flows/${flowId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["flow", flowId] });
      navigate(`/flows/${flowId}`);
    },
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
