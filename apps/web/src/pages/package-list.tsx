import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlows, usePackageList } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { PackageCard } from "../components/package-card";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: "flow" | "skill" | "extension" | "provider";
  source?: "built-in" | "local";
  runningExecutions?: number;
  tags?: string[];
  usedByFlows?: number;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  iconUrl?: string;
  autoInstalled?: boolean;
}

interface PackageTabProps {
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: string;
  emptyIcon?: LucideIcon;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  headerContent?: ReactNode;
}

export function PackageTab({
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

  const header =
    (isOrgAdmin && extraActions) || headerContent ? (
      <div className="flex items-center justify-between gap-2 mb-4">
        <div>{headerContent}</div>
        <div className="flex items-center gap-2">{isOrgAdmin && extraActions}</div>
      </div>
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

export interface ItemTabConfig {
  type: "skill" | "extension" | "provider";
  useData: () => {
    data:
      | {
          id: string;
          name?: string | null;
          description?: string | null;
          source?: "built-in" | "local";
          usedByFlows?: number;
          autoInstalled?: boolean;
        }[]
      | undefined;
    isLoading: boolean;
  };
  emptyMessageKey: string;
  emptyHintKey: string;
}

export const ITEM_TAB_CONFIGS: ItemTabConfig[] = [
  {
    type: "skill",
    useData: () => usePackageList("skill"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "extension",
    useData: () => usePackageList("extension"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "provider",
    useData: () => usePackageList("provider"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
];

export function ItemTab({
  config,
  badgeMap,
  actionsMap,
  iconMap,
  filterIds,
  headerContent,
  extraActions: externalActions,
  emptyExtraActions,
}: {
  config: ItemTabConfig;
  badgeMap?: Map<string, ReactNode>;
  actionsMap?: Map<string, ReactNode>;
  iconMap?: Map<string, string>;
  filterIds?: Set<string>;
  headerContent?: ReactNode;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
}) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: rawItems, isLoading } = config.useData();

  const typeLabel = t(`packages.type.${config.type}`);
  const filtered = filterIds ? rawItems?.filter((item) => filterIds.has(item.id)) : rawItems;
  const items: CardItem[] | undefined = filtered?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type: config.type,
    source: item.source,
    usedByFlows: item.usedByFlows,
    statusBadge: badgeMap?.get(item.id),
    actions: actionsMap?.get(item.id),
    iconUrl: iconMap?.get(item.id),
    autoInstalled: item.autoInstalled,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      emptyMessage={t(config.emptyMessageKey, { type: typeLabel })}
      emptyHint={t(config.emptyHintKey, { type: typeLabel })}
      extraActions={
        isOrgAdmin ? (
          <>
            {externalActions}
            <Link to={`/${config.type}s/new`}>
              <Button>{t("list.createItem", { ns: "flows" })}</Button>
            </Link>
          </>
        ) : undefined
      }
      emptyExtraActions={emptyExtraActions}
      headerContent={headerContent}
    />
  );
}

export const skillTabConfig = ITEM_TAB_CONFIGS[0];
export const extensionTabConfig = ITEM_TAB_CONFIGS[1];
export const providerTabConfig = ITEM_TAB_CONFIGS[2];

export function PackageList() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();

  const items: CardItem[] | undefined = flows?.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description,
    type: "flow",
    source: f.source,
    runningExecutions: f.runningExecutions,
    tags: f.tags,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      error={error}
      emptyMessage={t("list.empty")}
      emptyHint={t("list.emptyHint")}
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
