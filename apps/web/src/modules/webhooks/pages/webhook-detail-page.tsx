// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ResourceErrorState } from "@/components/page-states";
import { DetailTabs, UnderlineTabList } from "@/components/detail-tabs";
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
      {/* The overlay has no shell header to carry the tabs: they sit under the
          page, on a rule of their own (the band's, in a header). */}
      <DetailTabs value={tab} onChange={setTab}>
        <div className="mt-4 mb-6 shadow-[inset_0_-1px_0_0_var(--color-border)]">
          <UnderlineTabList
            tabs={[
              { value: "deliveries", label: t("settings:webhooks.deliveries") },
              { value: "settings", label: t("settings:webhooks.settings") },
            ]}
          />
        </div>
      </DetailTabs>

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
