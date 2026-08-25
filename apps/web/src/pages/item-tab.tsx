// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plug, Plus, Upload, Wrench } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { ImportModal } from "../components/import-modal";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";
import { PageActionsMenu } from "../components/page-actions-menu";

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
}: {
  /** Package type to list. Defaults to "skill" to preserve existing callers. */
  type?: BrowseType;
  /** When true, hides the "create" editor link (browse-only surface). */
  readOnly?: boolean;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { data: rawItems, isLoading } = usePackageList(type);
  const [importOpen, setImportOpen] = useState(false);

  const presentation = TYPE_PRESENTATION[type];
  const typeLabel = t(presentation.typeKey);
  const title = t(presentation.titleKey);
  const items: CardItem[] | undefined = rawItems?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type,
    source: item.source,
    usedByAgents: item.used_by_agents,
    autoInstalled: item.auto_installed,
  }));

  return (
    <>
      <PackageTab
        items={items}
        isLoading={isLoading}
        emoji={presentation.emoji}
        entity={title}
        holds={type}
        emptyMessage={t("packages.emptyItems", { type: typeLabel })}
        emptyHint={t("packages.emptyItemsHint", { type: typeLabel })}
        emptyIcon={presentation.emptyIcon}
        extraActions={
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="import" onSelect={() => setImportOpen(true)}>
              <Upload />
              {t("nav.import", { ns: "common" })}
            </DropdownMenuItem>
            {!readOnly && (
              <DropdownMenuItem asChild data-page-action="create">
                <Link to={packageNewPath(type)}>
                  <Plus />
                  {t("list.createItem", { ns: "agents", type: typeLabel })}
                </Link>
              </DropdownMenuItem>
            )}
          </PageActionsMenu>
        }
        title={title}
        breadcrumbs={[{ label: title }]}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
