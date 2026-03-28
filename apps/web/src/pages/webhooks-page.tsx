import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Webhook, ShieldAlert, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useOrg } from "../hooks/use-org";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useWebhooks } from "../hooks/use-webhooks";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { WebhookCreateModal } from "../components/webhook-create-modal";

export function WebhooksPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isOrgAdmin } = useOrg();
  const appId = useCurrentApplicationId();
  const { data: webhooks, isLoading, error } = useWebhooks();
  const [createOpen, setCreateOpen] = useState(false);

  if (!isOrgAdmin) {
    return (
      <EmptyState message={t("settings:webhooks.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <Button variant="outline">{t("common:btn.back")}</Button>
        </Link>
      </EmptyState>
    );
  }

  if (!appId) return <EmptyState message={t("applications.noAppSelected")} icon={Webhook} />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{t("settings:webhooks.pageTitle")}</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={16} className="mr-1.5" />
          {t("settings:webhooks.createTitle")}
        </Button>
      </div>

      {!webhooks || webhooks.length === 0 ? (
        <EmptyState message={t("settings:webhooks.empty")} icon={Webhook}>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={16} className="mr-1.5" />
            {t("settings:webhooks.createTitle")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {webhooks.map((wh) => (
            <Link
              key={wh.id}
              to={`/webhooks/${wh.id}`}
              className="block rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm truncate">{wh.url}</span>
                    <Badge variant={wh.active ? "success" : "secondary"}>
                      {wh.active ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{wh.events.join(", ")}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {wh.packageId || t("settings:webhooks.allFlows")}
                    {" · "}
                    {t("settings:webhooks.payloadMode")}: {wh.payloadMode}
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
