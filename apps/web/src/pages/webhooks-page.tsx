import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Webhook } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApplications } from "../hooks/use-applications";
import { useWebhooks } from "../hooks/use-webhooks";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { WebhookCreateModal } from "../components/webhook-create-modal";

type ScopeTab = "all" | "organization" | "application";

export function WebhooksPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data: applications } = useApplications();
  const [createOpen, setCreateOpen] = useState(false);
  const [scopeTab, setScopeTab] = useState<ScopeTab>("all");
  const [appFilter, setAppFilter] = useState<string>("all");

  const filters: { scope?: string; applicationId?: string } = {};
  if (scopeTab !== "all") filters.scope = scopeTab;
  if (scopeTab === "application" && appFilter !== "all") filters.applicationId = appFilter;

  const {
    data: webhooks,
    isLoading,
    error,
  } = useWebhooks(Object.keys(filters).length > 0 ? filters : undefined);

  if (!isAdmin) return null;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const appMap = new Map((applications ?? []).map((a) => [a.id, a.name]));

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
      >
        <Tabs
          value={scopeTab}
          onValueChange={(v) => {
            setScopeTab(v as ScopeTab);
            if (v !== "application") setAppFilter("all");
          }}
          className="mt-2"
        >
          <TabsList>
            <TabsTrigger value="all">{t("settings:webhooks.filterAll")}</TabsTrigger>
            <TabsTrigger value="organization">
              {t("settings:webhooks.scopeOrganization")}
            </TabsTrigger>
            <TabsTrigger value="application">{t("settings:webhooks.scopeApplication")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {/* App filter — only when on Application tab */}
      {scopeTab === "application" && (applications ?? []).length > 0 && (
        <div className="mb-4">
          <Select value={appFilter} onValueChange={setAppFilter}>
            <SelectTrigger className="w-48" aria-label={t("settings:webhooks.applicationLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("settings:webhooks.filterAllApps")}</SelectItem>
              {(applications ?? []).map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

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
              className="block rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-sm truncate">{wh.url}</span>
                    <Badge variant={wh.active ? "success" : "secondary"}>
                      {wh.active ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
                    </Badge>
                    <Badge variant="outline">
                      {wh.scope === "organization"
                        ? t("settings:webhooks.scopeBadgeOrg")
                        : wh.applicationId && appMap.has(wh.applicationId)
                          ? appMap.get(wh.applicationId)
                          : t("settings:webhooks.scopeBadgeApp")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{wh.events.join(", ")}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {wh.packageId || t("settings:webhooks.allFlows")}
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
