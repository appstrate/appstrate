// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportModal } from "../components/import-modal";
import { usePackageList } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";

const SKILL_EMOJI = "🧠";

export function ItemTab({
  badgeMap,
  actionsMap,
  iconMap,
  filterIds,
  headerContent,
  extraActions: externalActions,
  emptyExtraActions,
  title: externalTitle,
}: {
  badgeMap?: Map<string, ReactNode>;
  actionsMap?: Map<string, ReactNode>;
  iconMap?: Map<string, string>;
  filterIds?: Set<string>;
  headerContent?: ReactNode;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  title?: string;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { data: rawItems, isLoading } = usePackageList("skill");
  const [importOpen, setImportOpen] = useState(false);

  const typeLabel = t("packages.type.skill");
  const title = externalTitle ?? t("packages.type.skills");
  const filtered = filterIds ? rawItems?.filter((item) => filterIds.has(item.id)) : rawItems;
  const items: CardItem[] | undefined = filtered?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type: "skill",
    source: item.source,
    usedByAgents: item.usedByAgents,
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
        emoji={SKILL_EMOJI}
        emptyMessage={t("packages.emptyItems", { type: typeLabel })}
        emptyHint={t("packages.emptyItemsHint", { type: typeLabel })}
        emptyIcon={Wrench}
        extraActions={
          <>
            {externalActions}
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              {t("nav.import", { ns: "common" })}
            </Button>
            <Link to={packageNewPath("skill")}>
              <Button>{t("list.createItem", { ns: "agents", type: typeLabel })}</Button>
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
