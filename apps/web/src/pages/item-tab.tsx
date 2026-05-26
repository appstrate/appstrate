// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Wrench, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportModal } from "../components/import-modal";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";

type BrowseType = Extract<PackageType, "skill" | "mcp-server">;

/** Per-type presentation for the generic browse tab. */
const TYPE_PRESENTATION: Record<
  BrowseType,
  { emoji: string; emptyIcon: typeof Wrench; typeKey: string; titleKey: string }
> = {
  skill: {
    emoji: "🧠",
    emptyIcon: Wrench,
    typeKey: "packages.type.skill",
    titleKey: "packages.type.skills",
  },
  "mcp-server": {
    emoji: "🔌",
    emptyIcon: Plug,
    typeKey: "packages.type.mcp-server",
    titleKey: "packages.type.mcp-servers",
  },
};

export function ItemTab({
  type = "skill",
  readOnly = false,
  badgeMap,
  actionsMap,
  iconMap,
  filterIds,
  headerContent,
  extraActions: externalActions,
  emptyExtraActions,
  title: externalTitle,
}: {
  /** Package type to list. Defaults to "skill" to preserve existing callers. */
  type?: BrowseType;
  /** When true, hides the "create" editor link (browse-only surface). */
  readOnly?: boolean;
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
  const { data: rawItems, isLoading } = usePackageList(type);
  const [importOpen, setImportOpen] = useState(false);

  const presentation = TYPE_PRESENTATION[type];
  const typeLabel = t(presentation.typeKey);
  const title = externalTitle ?? t(presentation.titleKey);
  const filtered = filterIds ? rawItems?.filter((item) => filterIds.has(item.id)) : rawItems;
  const items: CardItem[] | undefined = filtered?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type,
    source: item.source,
    usedByAgents: item.used_by_agents,
    statusBadge: badgeMap?.get(item.id),
    actions: actionsMap?.get(item.id),
    iconUrl: iconMap?.get(item.id),
    autoInstalled: item.auto_installed,
  }));

  return (
    <>
      <PackageTab
        items={items}
        isLoading={isLoading}
        emoji={presentation.emoji}
        emptyMessage={t("packages.emptyItems", { type: typeLabel })}
        emptyHint={t("packages.emptyItemsHint", { type: typeLabel })}
        emptyIcon={presentation.emptyIcon}
        extraActions={
          <>
            {externalActions}
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              {t("nav.import", { ns: "common" })}
            </Button>
            {!readOnly && (
              <Link to={packageNewPath(type)}>
                <Button>{t("list.createItem", { ns: "agents", type: typeLabel })}</Button>
              </Link>
            )}
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
