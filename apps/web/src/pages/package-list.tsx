// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAgents } from "../hooks/use-packages";
import { useInstalledPackages } from "../hooks/use-installed-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { usePermissions } from "../hooks/use-permissions";

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningRuns?: number;
  keywords?: string[];
  providerIds?: string[];
  usedByAgents?: number;
  unreadCount?: number;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  iconUrl?: string;
  autoInstalled?: boolean;
}

interface PackageTabProps {
  title?: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: ReactNode;
  emptyIcon: LucideIcon;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  headerContent?: ReactNode;
}

export function PackageTab({
  title,
  emoji,
  breadcrumbs,
  items,
  isLoading,
  error,
  emptyMessage,
  emptyHint,
  emptyIcon,
  extraActions,
  emptyExtraActions,
  headerContent,
}: PackageTabProps) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const header = title ? (
    <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs} actions={extraActions}>
      {headerContent}
    </PageHeader>
  ) : null;

  const emptyActions = emptyExtraActions !== undefined ? emptyExtraActions : extraActions;

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {emptyActions}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((item) => (
          <PackageCard key={item.id} {...item} />
        ))}
      </div>
    </>
  );
}

export function PackageList() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents, isLoading, error } = useAgents();
  const { data: installedPackages } = useInstalledPackages("agent");
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);

  const installedIds = new Set(installedPackages?.map((p) => p.packageId) ?? []);

  const items: CardItem[] | undefined = agents?.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description,
    type: "agent",
    source: f.source,
    runningRuns: f.runningRuns,
    keywords: f.keywords,
    providerIds: f.dependencies.providers,
    unreadCount: unreadCounts?.[f.id],
    statusBadge: installedIds.has(f.id) ? <Badge variant="success">Installé</Badge> : null,
  }));

  return (
    <>
      <PackageTab
        title={t("list.tabAgents")}
        emoji="⚡"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("list.tabAgents") },
        ]}
        items={items}
        isLoading={isLoading}
        error={error}
        emptyMessage={t("list.empty")}
        emptyHint={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
        emptyIcon={Layers}
        extraActions={
          isAdmin ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                {t("nav.import", { ns: "common" })}
              </Button>
              <Link to="/agents/new">
                <Button>{t("list.create")}</Button>
              </Link>
            </>
          ) : undefined
        }
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
