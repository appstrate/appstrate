import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { type CardItem, PackageTab } from "./package-list";
import type { ItemTabConfig } from "./item-tab-configs";
import { packageNewPath } from "../lib/package-paths";

export function ItemTab({
  config,
  badgeMap,
  actionsMap,
  iconMap,
  filterIds,
  headerContent,
  extraActions: externalActions,
  emptyExtraActions,
  title: externalTitle,
}: {
  config: ItemTabConfig;
  badgeMap?: Map<string, ReactNode>;
  actionsMap?: Map<string, ReactNode>;
  iconMap?: Map<string, string>;
  filterIds?: Set<string>;
  headerContent?: ReactNode;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  title?: string;
}) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: rawItems, isLoading } = config.useData();

  const typeLabel = t(`packages.type.${config.type}`);
  const title = externalTitle ?? t(`packages.type.${config.type}s`);
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
            <Link to={packageNewPath(config.type)}>
              <Button>{t("list.createItem", { ns: "flows" })}</Button>
            </Link>
          </>
        ) : undefined
      }
      emptyExtraActions={emptyExtraActions}
      headerContent={headerContent}
      title={title}
    />
  );
}
