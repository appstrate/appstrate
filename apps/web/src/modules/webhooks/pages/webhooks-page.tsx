// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Webhook } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWebhooks } from "@/hooks/use-webhooks";
import { PageHeader } from "@/components/page-header";
import { LoadingState, ErrorState, EmptyState } from "@/components/page-states";
import { WebhookCreateModal } from "@/components/webhook-create-modal";

export function WebhooksPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: webhooks, isLoading, error } = useWebhooks();

  if (!isAdmin) return null;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div>
      <PageHeader
        title={t("settings:webhooks.pageTitle")}
        emoji="🪝"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("settings:webhooks.pageTitle") },
        ]}
        actions={
          <Button onClick={() => setCreateOpen(true)}>{t("settings:webhooks.createTitle")}</Button>
        }
      />

      {!webhooks || webhooks.length === 0 ? (
        <EmptyState message={t("settings:webhooks.empty")} icon={Webhook}>
          <Button onClick={() => setCreateOpen(true)}>{t("settings:webhooks.createTitle")}</Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {webhooks.map((wh) => (
            <Link
              key={wh.id}
              to={`/webhooks/${wh.id}`}
              className="border-border bg-card hover:bg-accent/50 block rounded-lg border p-4 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{wh.url}</span>
                    <Badge variant={wh.enabled ? "success" : "secondary"}>
                      {wh.enabled ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">{wh.events.join(", ")}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {wh.packageId || t("settings:webhooks.allAgents")}
                    {" · "}
                    {t("settings:webhooks.payloadMode")}:{" "}
                    {wh.payloadMode === "full"
                      ? t("settings:webhooks.payloadModeFull")
                      : t("settings:webhooks.payloadModeSummary")}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <WebhookCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
