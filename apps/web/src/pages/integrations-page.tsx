// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration catalogue.
 *
 *   - Tabs: Activés (active in this app) / Installés (full catalogue).
 *   - Search: by displayName, name, description, keywords.
 *   - Per-card: an "Activé / Non activé" badge + a "Configurer" button
 *     that opens the detail page. Activation/deactivation itself lives on
 *     the detail page.
 *
 * Detail flows (activate, per-auth connect, OAuth client registration,
 * governance) live on `<IntegrationDetailPage />`.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Boxes, Search, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useIntegrations, type IntegrationSummary } from "../hooks/use-integrations";

function matchesQuery(integration: IntegrationSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const m = integration.manifest;
  return (
    integration.id.toLowerCase().includes(q) ||
    m.displayName.toLowerCase().includes(q) ||
    (m.description?.toLowerCase().includes(q) ?? false) ||
    (m.keywords?.some((k) => k.toLowerCase().includes(q)) ?? false)
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation("settings");
  return active ? (
    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-500">
      {t("integrations.badge.active")}
    </span>
  ) : (
    <span className="bg-warning/10 text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
      {t("integrations.badge.inactive")}
    </span>
  );
}

function IntegrationCard({ integration }: { integration: IntegrationSummary }) {
  const { t } = useTranslation("settings");
  const m = integration.manifest;
  const isSystem = integration.source === "system";
  const isActive = Boolean(integration.active);

  return (
    <div
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="bg-card flex flex-col rounded-lg border p-4 transition-shadow hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        {m.icon ? (
          <img
            src={m.icon}
            alt=""
            className="size-10 rounded-md object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-md">
            <Boxes size={20} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{m.displayName}</h3>
            <Badge variant="outline" className="font-mono text-xs">
              v{m.version}
            </Badge>
          </div>
          <p className="text-muted-foreground truncate font-mono text-xs">{integration.id}</p>
        </div>
        <ActiveBadge active={isActive} />
      </div>
      {m.description && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{m.description}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {isSystem ? (
          <Badge variant="secondary">{t("integrations.badge.system")}</Badge>
        ) : (
          <Badge variant="secondary">{t("integrations.badge.org")}</Badge>
        )}
        {m.auths &&
          Object.entries(m.auths).map(([key, auth]) => (
            <Badge key={key} variant="outline" className="font-mono text-[0.65rem]">
              {key}:{auth.type}
            </Badge>
          ))}
      </div>
      <div className="mt-auto flex items-center pt-4">
        <div className="flex-1" />
        <Button asChild variant="outline" size="sm" data-testid="integration-configure-btn">
          <Link to={`/integrations/${integration.id}`}>
            <Settings size={14} className="mr-1" />
            {t("integrations.btn.configure")}
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<"active" | "all">("active");
  const [query, setQuery] = useState("");
  const { data: integrations, isLoading, error } = useIntegrations();

  const filtered = useMemo(() => {
    const list = integrations ?? [];
    return list.filter((i) => {
      if (tab === "active" && !i.active) return false;
      return matchesQuery(i, query);
    });
  }, [integrations, tab, query]);

  return (
    <div className="p-6">
      <PageHeader emoji="🧩" title={t("integrations.title")}>
        <p className="text-muted-foreground mt-1 text-sm">{t("integrations.subtitle")}</p>
      </PageHeader>

      <div className="mb-4 flex items-center gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "active" | "all")}>
          <TabsList>
            <TabsTrigger value="active">{t("integrations.tabs.active")}</TabsTrigger>
            <TabsTrigger value="all">{t("integrations.tabs.all")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative max-w-md flex-1">
          <Search
            size={14}
            className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("integrations.search.placeholder")}
            className="pl-9"
            data-testid="integrations-search"
          />
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={String(error)} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          message={tab === "active" ? t("integrations.empty.active") : t("integrations.empty.all")}
        />
      ) : (
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="integration-grid"
        >
          {filtered.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}
    </div>
  );
}
