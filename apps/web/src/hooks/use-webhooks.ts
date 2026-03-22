import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  flowId: string | null;
  payloadMode: "full" | "summary";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreateResponse extends WebhookInfo {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  latency: number | null;
  attempt: number;
  error: string | null;
  createdAt: string;
}

export const WEBHOOK_EVENTS = [
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.timeout",
  "execution.cancelled",
] as const;

export function useWebhooks() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, appId],
    queryFn: () =>
      api<{ object: "list"; data: WebhookInfo[] }>(
        `/webhooks${appId ? `?applicationId=${appId}` : ""}`,
      ).then((d) => d.data),
    enabled: !!orgId && !!appId,
  });
}

export function useWebhook(webhookId: string) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["webhooks", orgId, webhookId],
    queryFn: () => api<WebhookInfo>(`/webhooks/${webhookId}`),
    enabled: !!orgId && !!webhookId,
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      url: string;
      events: string[];
      flowId?: string | null;
      payloadMode?: "full" | "summary";
      active?: boolean;
    }) => {
      return api<WebhookCreateResponse>("/webhooks", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useUpdateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        url?: string;
        events?: string[];
        flowId?: string | null;
        payloadMode?: "full" | "summary";
        active?: boolean;
      };
    }) => {
      return api<WebhookInfo>(`/webhooks/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/webhooks/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useTestWebhook() {
  return useMutation({
    mutationFn: async (id: string) => {
      return api<{ eventId: string; payload: unknown }>(`/webhooks/${id}/test`, {
        method: "POST",
      });
    },
  });
}

export function useRotateWebhookSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api<{ secret: string }>(`/webhooks/${id}/rotate`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useWebhookDeliveries(webhookId: string) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["webhooks", orgId, webhookId, "deliveries"],
    queryFn: () =>
      api<{ object: "list"; data: WebhookDelivery[] }>(`/webhooks/${webhookId}/deliveries`).then(
        (d) => d.data,
      ),
    enabled: !!orgId && !!webhookId,
  });
}
