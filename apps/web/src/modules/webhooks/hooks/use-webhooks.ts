// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, SetStateAction } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "@appstrate/shared-types";
import { api, apiList } from "@/api";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentApplicationId } from "@/hooks/use-current-application";

export type { WebhookInfo, WebhookCreateResponse, WebhookDelivery };

/** Toggle an event in a state setter — shared by create and edit forms. */
export function toggleEvent(event: string, setter: Dispatch<SetStateAction<string[]>>) {
  setter((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
}

export const WEBHOOK_EVENTS = [
  "run.started",
  "run.success",
  "run.failed",
  "run.timeout",
  "run.cancelled",
] as const;

/**
 * List webhooks for the current application.
 * All webhooks are now application-scoped (X-Application-Id sent automatically by api.ts).
 */
export function useWebhooks() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, applicationId],
    queryFn: () => apiList<WebhookInfo>("/webhooks"),
    enabled: !!orgId && !!applicationId,
  });
}

export function useWebhook(webhookId: string) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, applicationId, webhookId],
    queryFn: () => api<WebhookInfo>(`/webhooks/${webhookId}`),
    enabled: !!orgId && !!applicationId && !!webhookId,
  });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      url: string;
      events: string[];
      packageId?: string | null;
      payloadMode?: "full" | "summary";
      enabled?: boolean;
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
        packageId?: string | null;
        payloadMode?: "full" | "summary";
        enabled?: boolean;
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
      return api<{ secret: string; secretPrevious: string; rotationWindowEndsAt: string }>(
        `/webhooks/${id}/rotate`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useWebhookDeliveries(webhookId: string) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, applicationId, webhookId, "deliveries"],
    queryFn: () => apiList<WebhookDelivery>(`/webhooks/${webhookId}/deliveries`),
    enabled: !!orgId && !!applicationId && !!webhookId,
  });
}
