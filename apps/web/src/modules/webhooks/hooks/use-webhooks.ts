// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { WebhookDelivery } from "@appstrate/shared-types";
import { $api, client, type components, type paths } from "@/api/client";
import { invalidatePaths } from "@/lib/query-keys";
import { keysetPaging } from "@/lib/keyset-paging";
import { useInvalidatePaths } from "@/hooks/use-invalidate-paths";
import { useOrgOnlyScope } from "@/hooks/use-org-scope";
import { useCurrentSpaceId } from "@/hooks/use-current-space";
import { usePermissions } from "@/hooks/use-permissions";

/** Wire shape from the OpenAPI spec (components.schemas.WebhookObject). */
export type WebhookInfo = components["schemas"]["WebhookObject"];
export type { WebhookDelivery };

type CreateWebhookBody =
  paths["/api/webhooks"]["post"]["requestBody"]["content"]["application/json"];

/** Wire enum for webhook events, derived from the create body. */
export type WebhookEvent = Extract<CreateWebhookBody, { level: "space" }>["events"][number];

/** Keyed by the wire enum: a list that falls behind the API's does not compile. */
const WEBHOOK_EVENT_SET: Record<WebhookEvent, true> = {
  "run.started": true,
  "run.success": true,
  "run.failed": true,
  "run.timeout": true,
  "run.cancelled": true,
  "run.connection_missing": true,
};
export const WEBHOOK_EVENTS = Object.keys(WEBHOOK_EVENT_SET) as WebhookEvent[];

/** `X-Org-Id` is passed explicitly so it is part of the query key (org switch refetches). */
function useWebhookScope() {
  const org = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  return { enabled: org.enabled && !!spaceId, header: org.header, spaceId };
}

/** Org-level webhooks plus those pinned to the current space (`spaceId` filter). */
export function useWebhooks() {
  const scope = useWebhookScope();
  // The `spaceId` filter asks for space `webhooks:read` on top of the list's
  // either-level guard; an org-level reader alone lists the org rows only.
  const spaceFilter = usePermissions().can("webhooks:read") ? scope.spaceId : null;
  return $api.useQuery(
    "get",
    "/api/webhooks",
    {
      params: {
        query: { spaceId: spaceFilter ?? undefined },
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

const useInvalidateWebhooks = () =>
  useInvalidatePaths("/api/webhooks", "/api/webhooks/{id}", "/api/webhooks/{id}/deliveries");

export function useCreateWebhook() {
  const invalidate = useInvalidateWebhooks();
  const spaceId = useCurrentSpaceId();
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async ({
      level,
      ...data
    }: {
      level: WebhookInfo["level"];
      url: string;
      events: string[];
      packageId?: string | null;
      payloadMode?: "full" | "summary";
      enabled?: boolean;
    }) => {
      // A space-level webhook is pinned to the CURRENT space. Form state holds
      // plain strings, cast to the wire enum here.
      const events = data.events as WebhookEvent[];
      const body: CreateWebhookBody =
        level === "org"
          ? { level, ...data, events }
          : { level, spaceId: spaceId!, ...data, events };
      const { data: created } = await client.POST("/api/webhooks", { body });
      if (!created) throw new Error("empty response");
      return created;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateWebhook() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("patch", "/api/webhooks/{id}", { onSuccess: invalidate });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/webhooks/{id}", {
    onSuccess: () => {
      void invalidatePaths(qc, ["/api/webhooks"]);
      // The page still showing the deleted webhook would re-read it, a 404: stale only.
      void invalidatePaths(qc, ["/api/webhooks/{id}", "/api/webhooks/{id}/deliveries"], "none");
    },
  });
}

export function useTestWebhook() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("post", "/api/webhooks/{id}/test", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useRotateWebhookSecret() {
  const invalidate = useInvalidateWebhooks();
  return $api.useMutation("post", "/api/webhooks/{id}/rotate", { onSuccess: invalidate });
}

/** Delivery history, keyset-paged. The key keeps the `[method, path, init]` prefix so `useInvalidateWebhooks` reaches it. */
export function useWebhookDeliveries(webhookId: string) {
  const scope = useWebhookScope();
  const params = { path: { id: webhookId }, header: scope.header };
  return useInfiniteQuery({
    queryKey: ["get", "/api/webhooks/{id}/deliveries", { params }] as const,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await client.GET("/api/webhooks/{id}/deliveries", {
        params: { ...params, query: { startingAfter: pageParam } },
        signal,
      });
      if (!data) throw new Error("empty response");
      return data;
    },
    ...keysetPaging,
    enabled: scope.enabled && !!webhookId,
  });
}
