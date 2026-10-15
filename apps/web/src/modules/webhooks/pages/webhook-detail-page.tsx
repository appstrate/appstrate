// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { ResourceErrorState } from "@/components/page-states";
import { SettingsSkeleton } from "@/components/loading-skeletons";
import { SettingsPageActions } from "@/components/settings/settings-page-actions";
import { useBreadcrumb } from "@/stores/breadcrumb-store";
import { WebhookDeliveriesTab } from "../components/webhook-deliveries-tab";
import { WebhookSettingsTab } from "../components/webhook-settings-tab";
import { useTabWithHash } from "@/hooks/use-tab-with-hash";
import { useWebhook } from "../hooks/use-webhooks";

/** One webhook, under the settings' Webhooks page: its URL extends the settings trail. */
export function WebhookDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const { data: webhook, isLoading, error } = useWebhook(id!);

  const [tab, setTab] = useTabWithHash(["deliveries", "settings"] as const, "deliveries");
  useBreadcrumb("overlayPage", webhook ? [{ label: webhook.url }] : []);

  if (error || (!isLoading && !webhook)) return <ResourceErrorState error={error} />;

  return (
    <div>
      {webhook && (
        <SettingsPageActions>
          {webhook.level === "org" && <Badge variant="outline">{t("settings:source.org")}</Badge>}
          <Badge variant={webhook.enabled ? "success" : "secondary"}>
            {webhook.enabled
              ? t("settings:catalogue.filter.active")
              : t("settings:webhooks.inactive")}
          </Badge>
        </SettingsPageActions>
      )}

      {webhook ? (
        <p className="text-muted-foreground font-mono text-sm break-all">{webhook.url}</p>
      ) : (
        <Skeleton className="h-4 w-80 max-w-full" />
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-4 mb-4">
        <TabsList>
          <TabsTrigger value="deliveries">{t("settings:webhooks.deliveries")}</TabsTrigger>
          <TabsTrigger value="settings">{t("settings:webhooks.settings")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "deliveries" && <WebhookDeliveriesTab webhookId={id!} />}
      {tab === "settings" &&
        (webhook ? (
          <WebhookSettingsTab key={webhook.id} webhook={webhook} />
        ) : (
          <SettingsSkeleton />
        ))}
    </div>
  );
}
