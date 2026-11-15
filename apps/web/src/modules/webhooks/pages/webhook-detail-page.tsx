// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Badge } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { ResourceErrorState } from "@/components/page-states";
import { DetailTabPanel, DetailTabs, UnderlineTabList } from "@/components/detail-tabs";
import { SettingsSkeleton, Waiting } from "@/components/loading-skeletons";
import { SettingsPageBadges } from "@/components/settings/settings-page-actions";
import { useOverlayPageBreadcrumb } from "@/hooks/use-overlay-breadcrumb";
import { useTabWithHash } from "@/hooks/use-tab-with-hash";
import { isQueryInFlight } from "@/lib/query-state";
import { WebhookDeliveriesTab } from "../components/webhook-deliveries-tab";
import { WebhookSettingsTab } from "../components/webhook-settings-tab";
import { useWebhook } from "../hooks/use-webhooks";

const WEBHOOK_TABS = ["deliveries", "settings"] as const;

/** The tab bar's box and the panel under it, while the webhook is read. */
function WebhookDetailSkeleton() {
  return (
    <Waiting>
      <div className="mb-6 flex h-11 items-center gap-4 shadow-[inset_0_-1px_0_0_var(--color-border)]">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-20" />
      </div>
      <SettingsSkeleton />
    </Waiting>
  );
}

/**
 * One webhook, under the settings' Webhooks page: its URL is the settings heading (through the
 * crumb it appends), its status pills sit beside it.
 */
export function WebhookDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const query = useWebhook(id!);
  const { data: webhook, error } = query;

  const [tab, setTab] = useTabWithHash(WEBHOOK_TABS, "deliveries");
  useOverlayPageBreadcrumb(webhook ? [{ label: webhook.url }] : []);

  if (isQueryInFlight(query)) return <WebhookDetailSkeleton />;
  if (error || !webhook) return <ResourceErrorState error={error} />;

  return (
    <div>
      <SettingsPageBadges>
        {webhook.level === "org" && <Badge variant="outline">{t("settings:source.org")}</Badge>}
        <Badge variant={webhook.enabled ? "success" : "secondary"}>
          {webhook.enabled
            ? t("settings:catalogue.filter.active")
            : t("settings:webhooks.inactive")}
        </Badge>
      </SettingsPageBadges>

      {/* The overlay has no shell header to carry the tabs: they sit under the
          page, on a rule of their own (the band's, in a header). */}
      <DetailTabs value={tab} onChange={setTab}>
        <div className="mb-6 shadow-[inset_0_-1px_0_0_var(--color-border)]">
          <UnderlineTabList
            tabs={[
              { value: "deliveries", label: t("settings:webhooks.deliveries") },
              { value: "settings", label: t("settings:webhooks.settings") },
            ]}
          />
        </div>
        <DetailTabPanel value="deliveries">
          <WebhookDeliveriesTab webhookId={id!} />
        </DetailTabPanel>
        <DetailTabPanel value="settings">
          <WebhookSettingsTab key={webhook.id} webhook={webhook} />
        </DetailTabPanel>
      </DetailTabs>
    </div>
  );
}
