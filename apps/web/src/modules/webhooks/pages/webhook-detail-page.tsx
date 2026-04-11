// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { LoadingState, ErrorState } from "@/components/page-states";
import { WebhookDeliveriesTab } from "@/components/webhook-deliveries-tab";
import { WebhookSettingsTab } from "@/components/webhook-settings-tab";
import { useTabWithHash } from "@/hooks/use-tab-with-hash";
import { useWebhook } from "@/hooks/use-webhooks";

export function WebhookDetailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { id } = useParams<{ id: string }>();
  const { data: webhook, isLoading, error } = useWebhook(id!);

  const [tab, setTab] = useTabWithHash(["deliveries", "settings"] as const, "deliveries");

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!webhook) return <ErrorState />;

  return (
    <div>
      <PageHeader
        title={webhook.url}
        emoji="🪝"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("settings:webhooks.pageTitle"), href: "/webhooks" },
          { label: webhook.url },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={webhook.enabled ? "success" : "secondary"}>
              {webhook.enabled ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
            </Badge>
          </div>
        }
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-2">
          <TabsList>
            <TabsTrigger value="deliveries">{t("settings:webhooks.deliveries")}</TabsTrigger>
            <TabsTrigger value="settings">{t("settings:webhooks.settings")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {tab === "deliveries" && <WebhookDeliveriesTab webhookId={id!} />}
      {tab === "settings" && <WebhookSettingsTab key={webhook.id} webhook={webhook} />}
    </div>
  );
}
