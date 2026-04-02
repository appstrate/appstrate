// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, SetStateAction } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
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

export function useWebhooks(filters?: { scope?: string; applicationId?: string }) {
  const orgId = useCurrentOrgId();
  const params = new URLSearchParams();
  if (filters?.scope) params.set("scope", filters.scope);
  if (filters?.applicationId) params.set("applicationId", filters.applicationId);
  const qs = params.toString();
  return useQuery({
    queryKey: ["webhooks", orgId, filters?.scope ?? "all", filters?.applicationId ?? "all"],
    queryFn: () =>
      api<{ object: "list"; data: WebhookInfo[] }>(`/webhooks${qs ? `?${qs}` : ""}`).then(
        (d) => d.data,
      ),
    enabled: !!orgId,
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
      scope: "organization" | "application";
      applicationId?: string;
      url: string;
      events: string[];
      packageId?: string | null;
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
        packageId?: string | null;
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
