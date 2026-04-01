import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LoadingState, ErrorState, EmptyState } from "./page-states";
import { useWebhookDeliveries } from "../hooks/use-webhooks";
import type { WebhookDelivery } from "../hooks/use-webhooks";

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
  const { t } = useTranslation(["settings", "common"]);
  const { data: deliveries, isLoading, error } = useWebhookDeliveries(webhookId);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  if (!deliveries || deliveries.length === 0) {
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
    </div>
  );
}
