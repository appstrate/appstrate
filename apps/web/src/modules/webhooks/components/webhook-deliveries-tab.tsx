// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { LoadingState, ErrorState, EmptyState } from "@/components/page-states";
import { useWebhookDeliveries } from "../hooks/use-webhooks";
import type { WebhookDelivery } from "../hooks/use-webhooks";
import { getErrorMessage } from "@appstrate/core/errors";

function formatRelativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("webhooks.lessThanMinute");
  if (minutes < 60) return t("webhooks.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("webhooks.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("webhooks.daysAgo", { count: days });
}

function deliveryStatusVariant(d: WebhookDelivery): "success" | "failed" | "pending" {
  if (d.status === "pending") return "pending";
  if (d.statusCode && d.statusCode >= 200 && d.statusCode < 300) return "success";
  return "failed";
}

function deliveryStatusLabel(d: WebhookDelivery): string {
  if (d.status === "pending") return "pending";
  if (d.statusCode) return `${d.statusCode}`;
  return d.status;
}

export function WebhookDeliveriesTab({ webhookId }: { webhookId: string }) {
  // Remount per webhook so the cursor + accumulated pages reset.
  return <DeliveryPages key={webhookId} webhookId={webhookId} />;
}

function DeliveryPages({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = useState<WebhookDelivery[]>([]);
  const { data, isLoading, error } = useWebhookDeliveries(webhookId, cursor);

  const currentPage = useMemo(() => data?.data ?? [], [data?.data]);
  const hasMore = data?.hasMore ?? false;

  // Merge accumulated pages with the current one, deduping by id (the current
  // page briefly overlaps the accumulator between "Load more" and the fetch).
  const deliveries = useMemo(() => {
    const seen = new Set<string>();
    return [...loadedPages, ...currentPage].filter((d) => !seen.has(d.id) && seen.add(d.id));
  }, [loadedPages, currentPage]);

  if (isLoading && deliveries.length === 0) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  if (deliveries.length === 0) {
    return <EmptyState message={t("settings:webhooks.noDeliveries")} icon={Send} compact />;
  }

  return (
    <div className="space-y-2">
      {deliveries.map((d) => {
        const variant = deliveryStatusVariant(d);
        return (
          <div key={d.id} className="border-border bg-card rounded-lg border p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-muted-foreground truncate font-mono text-xs">{d.eventId}</span>
              <span className="font-mono text-sm">{d.eventType}</span>
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Badge variant={variant}>{deliveryStatusLabel(d)}</Badge>
              {d.latency != null && <span>{d.latency}ms</span>}
              <span>{t("settings:webhooks.deliveryAttempt", { attempt: d.attempt })}</span>
              <span>{formatRelativeTime(d.createdAt, t)}</span>
            </div>
            {d.error && <p className="text-destructive mt-1 text-xs">{d.error}</p>}
          </div>
        );
      })}
      {hasMore && (
        <Button
          variant="outline"
          className="mt-2"
          onClick={() => {
            const last = currentPage[currentPage.length - 1];
            if (last) {
              setLoadedPages((prev) => [...prev, ...currentPage]);
              setCursor(last.id);
            }
          }}
        >
          {t("settings:webhooks.loadMoreDeliveries")}
        </Button>
      )}
    </div>
  );
}
