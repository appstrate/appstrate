import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import type { PackageType } from "@appstrate/shared-types";
import { Button } from "@/components/ui/button";
import { useFlows } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { useUnreadCountsByFlow } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
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

  const header = (
    <div className="flex items-center justify-between gap-2 mb-4">
      <div className="flex items-center gap-3">
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        {headerContent}
      </div>
      <div className="flex items-center gap-2">{isOrgAdmin && extraActions}</div>
    </div>
  );

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
    <PackageTab
      title={t("list.tabFlows")}
      items={items}
      isLoading={isLoading}
      error={error}
      emptyMessage={t("list.empty")}
      emptyHint={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
      emptyIcon={Layers}
      extraActions={
        isOrgAdmin ? (
          <Link to="/flows/new">
            <Button>{t("list.create")}</Button>
          </Link>
        ) : undefined
      }
    />
  );
}
