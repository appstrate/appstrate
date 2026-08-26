// SPDX-License-Identifier: Apache-2.0

import type { Dispatch, SetStateAction } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WebhookDelivery } from "@appstrate/shared-types";
import { $api, client, type components, type paths } from "@/api/client";
import { useCurrentOrgId } from "@/hooks/use-org";
import { useCurrentSpaceId } from "@/hooks/use-current-space";

/** Wire shape from the OpenAPI spec (components.schemas.WebhookObject). */
export type WebhookInfo = components["schemas"]["WebhookObject"];
export type { WebhookDelivery };

type CreateWebhookBody =
  paths["/api/webhooks"]["post"]["requestBody"]["content"]["application/json"];

/** Wire enum for webhook events, derived from the create body. */
export type WebhookEvent = Extract<CreateWebhookBody, { level: "space" }>["events"][number];

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
 * Org/space context for queries. The spec-declared `X-Org-Id` header is passed
 * explicitly so it is part of the React Query key — switching org refetches
 * instead of serving another org's cached page.
 */
function useWebhookScope() {
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  return {
    enabled: !!orgId && !!spaceId,
    header: { "X-Org-Id": orgId ?? undefined },
    spaceId,
  };
}

/**
 * List webhooks for the current space — org-level webhooks plus those
 * pinned to the current space (the only kind this UI creates), via the
 * spec-declared `spaceId` filter.
 */
export function useWebhooks() {
  const scope = useWebhookScope();
  return $api.useQuery(
    "get",
    "/api/webhooks",
    {
      params: {
        query: { spaceId: scope.spaceId ?? undefined },
        header: scope.header,
      },
    },
    { enabled: scope.enabled, select: (e) => e.data ?? [] },
  );
}

export function useWebhook(webhookId: string) {
  const scope = useWebhookScope();
  return $api.useQuery(
    "get",
    "/api/webhooks/{id}",
    { params: { path: { id: webhookId }, header: scope.header } },
    { enabled: scope.enabled && !!webhookId },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — list, detail, and deliveries live under different path strings, so
 * all need invalidating after a write.
 */
function useInvalidateWebhooks() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/webhooks"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/webhooks/{id}"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/webhooks/{id}/deliveries"] });
  };
}

export function useCreateWebhook() {
  const invalidate = useInvalidateWebhooks();
  const spaceId = useCurrentSpaceId();
  return useMutation({
    mutationFn: async (data: {
      url: string;
      events: string[];
      packageId?: string | null;
      payloadMode?: "full" | "summary";
      enabled?: boolean;
    }) => {
      // Webhooks created from this UI are always pinned to the current
      // space — the level discriminator comes from context, not the
      // call site. Form state holds plain strings; the wire enum cast is the
      // same trust boundary as the legacy untyped helper.
      const body: CreateWebhookBody = {
        level: "space",
        spaceId: spaceId!,
        ...data,
        events: data.events as WebhookEvent[],
      };
      const { data: created } = await client.POST("/api/webhooks", { body });
      if (!created) throw new Error("empty response");
      return created;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("put", "/api/webhooks/{id}", { onSuccess: invalidate });
}

export function useDeleteWebhook() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("delete", "/api/webhooks/{id}", { onSuccess: invalidate });
}

export function useTestWebhook() {
  return $api.useMutation("post", "/api/webhooks/{id}/test");
}

export function useRotateWebhookSecret() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("post", "/api/webhooks/{id}/rotate", { onSuccess: invalidate });
}

export function useWebhookDeliveries(webhookId: string) {
  const scope = useWebhookScope();
  return $api.useQuery(
    "get",
    "/api/webhooks/{id}/deliveries",
    { params: { path: { id: webhookId }, header: scope.header } },
    {
      enabled: scope.enabled && !!webhookId,
      select: (e) => e.data ?? [],
    },
  );
}
