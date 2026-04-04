// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, SetStateAction } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "@appstrate/shared-types";
export type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "@appstrate/shared-types";

/** Toggle an event in a state setter — shared by create and edit forms. */
export function toggleEvent(event: string, setter: Dispatch<SetStateAction<string[]>>) {
  setter((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
}

export const WEBHOOK_EVENTS = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.timeout",
  "run.cancelled",
] as const;

/**
 * List webhooks for the current application.
 * All webhooks are now application-scoped (X-App-Id sent automatically by api.ts).
 */
export function useWebhooks() {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, appId],
    queryFn: () => api<{ object: "list"; data: WebhookInfo[] }>("/webhooks").then((d) => d.data),
    enabled: !!orgId && !!appId,
  });
}

export function useWebhook(webhookId: string) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["webhooks", orgId, appId, webhookId],
    queryFn: () => api<WebhookInfo>(`/webhooks/${webhookId}`),
    enabled: !!orgId && !!appId && !!webhookId,
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
