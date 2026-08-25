// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plug, Plus, Upload, Wrench } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { ImportModal } from "../components/import-modal";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import { usePermissions } from "../hooks/use-permissions";

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
  manualCreation = "editor",
}: {
  /** Package type to list. Defaults to "skill" to preserve existing callers. */
  type?: BrowseType;
  /** Existing manual destination for this collection. */
  manualCreation?: "editor" | "import";
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { data: rawItems, isLoading } = usePackageList(type);
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);
  const navigate = useNavigate();
  const creation = useCreationHandoff(type, isAdmin);

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
          isAdmin ? (
            <PageActionsMenu>
              <DropdownMenuItem data-page-action="import" onSelect={() => setImportOpen(true)}>
                <Upload />
                {t("nav.import", { ns: "common" })}
              </DropdownMenuItem>
              <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                <Plus />
                {t("list.createItem", { ns: "agents", type: typeLabel })}
              </DropdownMenuItem>
            </PageActionsMenu>
          ) : undefined
        }
        title={title}
        breadcrumbs={[{ label: title }]}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {creation.isOpen && (
        <CreationHandoffModal
          resource={type}
          onClose={creation.close}
          onManual={() => {
            if (manualCreation === "import") {
              creation.close();
              setImportOpen(true);
              return;
            }
            navigate(packageNewPath(type));
          }}
          onChat={creation.openChat}
        />
      )}
    </>
  );
}
