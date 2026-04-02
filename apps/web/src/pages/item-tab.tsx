// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ImportModal } from "../components/import-modal";
import type { PackageType } from "@appstrate/core/validation";
import { type CardItem, PackageTab } from "./package-list";
import type { ItemTabConfig } from "./item-tab-configs";
import { packageNewPath } from "../lib/package-paths";

const emojiMap: Record<PackageType, string> = {
  flow: "⚡",
  skill: "🧠",
  tool: "🔧",
  provider: "🔌",
};

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
  const { data: rawItems, isLoading } = config.useData();
  const [importOpen, setImportOpen] = useState(false);

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
    <>
      <PackageTab
        items={items}
        isLoading={isLoading}
        emoji={emojiMap[config.type]}
        emptyMessage={t(config.emptyMessageKey, { type: typeLabel })}
        emptyHint={t(config.emptyHintKey, { type: typeLabel })}
        emptyIcon={config.emptyIcon}
        extraActions={
          <>
            {externalActions}
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              {t("nav.import", { ns: "common" })}
            </Button>
            <Link to={packageNewPath(config.type)}>
              <Button>{t("list.createItem", { ns: "flows", type: typeLabel })}</Button>
            </Link>
          </>
        }
        emptyExtraActions={emptyExtraActions}
        headerContent={headerContent}
        title={title}
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: title },
        ]}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
