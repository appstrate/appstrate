// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { PendingButton } from "@/components/app-ui/pending-button";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { relativeAge } from "@appstrate/core/format";
import { ErrorState, EmptyState } from "@/components/page-states";
import { ItemList } from "@/components/item-list";
import { ListFooter } from "@/components/list-toolbar";
import { useWebhookDeliveries } from "../hooks/use-webhooks";
import type { WebhookDelivery } from "../hooks/use-webhooks";
import { errorMessage } from "../../../lib/mutation-error";

const AGE_KEY = {
  now: "webhooks.lessThanMinute",
  minute: "webhooks.minutesAgo",
  hour: "webhooks.hoursAgo",
  day: "webhooks.daysAgo",
  month: "webhooks.monthsAgo",
  year: "webhooks.yearsAgo",
} as const;

function formatRelativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const age = relativeAge(dateStr, Date.now());
  return age ? t(AGE_KEY[age.unit], { count: age.count }) : "";
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
  const {
    data,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useWebhookDeliveries(webhookId);
  const deliveries = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);

  // Only a failed FIRST load answers as a failure. Once rows are on screen, a
  // failed page (next or refetch) must not hide them: the footer says it.
  const failed = Boolean(error) && !data;

  return (
    <>
      <ItemList
        items={deliveries}
        itemKey={(d) => d.id}
        isLoading={isLoading}
        isError={failed}
        error={<ErrorState error={error} compact />}
        empty={<EmptyState message={t("settings:webhooks.noDeliveries")} icon={Send} compact />}
        renderItem={(d) => {
          const variant = deliveryStatusVariant(d);
          return (
            <div className="border-border bg-card rounded-lg border p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {d.eventId}
                </span>
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
        }}
      />
      <ListFooter
        count={
          error && data ? (
            <span className="text-destructive">
              {t("common:error.generic")} {errorMessage(error)}
            </span>
          ) : undefined
        }
      >
        {hasNextPage && !failed && (
          <PendingButton
            variant="outline"
            size="sm"
            pending={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchNextPageError
              ? t("common:btn.retry")
              : t("settings:webhooks.loadMoreDeliveries")}
          </PendingButton>
        )}
      </ListFooter>
    </>
  );
}
