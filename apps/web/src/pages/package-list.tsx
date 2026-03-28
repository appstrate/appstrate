import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import type { PackageType } from "@appstrate/shared-types";
import { Button } from "@/components/ui/button";
import { useFlows } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { useUnreadCountsByFlow } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningExecutions?: number;
  keywords?: string[];
  usedByFlows?: number;
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
  const { isOrgAdmin } = useOrg();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const header = title ? (
    <PageHeader
      title={title}
      emoji={emoji}
      breadcrumbs={breadcrumbs}
      actions={isOrgAdmin ? extraActions : undefined}
    >
      {headerContent}
    </PageHeader>
  ) : null;

  const emptyActions = emptyExtraActions !== undefined ? emptyExtraActions : extraActions;

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {isOrgAdmin && emptyActions}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
        {items.map((item) => (
          <PackageCard key={item.id} {...item} />
        ))}
      </div>
    </>
  );
}

export function PackageList() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();
  const { data: unreadCounts } = useUnreadCountsByFlow();
  const [importOpen, setImportOpen] = useState(false);

  const items: CardItem[] | undefined = flows?.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description,
    type: "flow",
    source: f.source,
    runningExecutions: f.runningExecutions,
    keywords: f.keywords,
    unreadCount: unreadCounts?.[f.id],
  }));

  return (
    <>
      <PackageTab
        title={t("list.tabFlows")}
        emoji="⚡"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("list.tabFlows") },
        ]}
        items={items}
        isLoading={isLoading}
        error={error}
        emptyMessage={t("list.empty")}
        emptyHint={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
        emptyIcon={Layers}
        extraActions={
          isOrgAdmin ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                {t("nav.import", { ns: "common" })}
              </Button>
              <Link to="/flows/new">
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
