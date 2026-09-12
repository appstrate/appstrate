// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LibraryBig, Plug, Plus, Upload, Wrench } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { ImportModal } from "../components/import-modal";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import { usePermissions } from "../hooks/use-permissions";
import { useModalParam } from "../hooks/use-modal-param";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
import { PackageCatalogueModal } from "../components/package-catalogue-modal";

type BrowseType = Extract<PackageType, "skill" | "mcp-server">;

/** Per-type presentation for the generic browse tab. */
const TYPE_PRESENTATION: Record<
  BrowseType,
  { emptyIcon: typeof Wrench; typeKey: string; titleKey: string }
> = {
  skill: {
    emptyIcon: Wrench,
    typeKey: "packages.type.skill",
    titleKey: "packages.type.skills",
  },
  "mcp-server": {
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
  // What works in THIS space; the rest of the org is one action away.
  const { data: rawItems, isLoading } = usePackageList(type, { activeOnly: true });
  const { can } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);
  const navigate = useNavigate();
  // Creating and importing are writes on the package type, as their routes are.
  const canCreate = can(type === "skill" ? "skills:write" : "mcp-servers:write");
  const creation = useCreationHandoff(type, canCreate);
  const canActivate = can(PACKAGE_PERMISSIONS[type].install);
  const catalogue = useModalParam("catalogue");

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
        entity={title}
        holds={type}
        emptyMessage={t("packages.emptyItems", { type: typeLabel })}
        emptyHint={t("packages.emptyItemsHint", { type: typeLabel })}
        emptyIcon={presentation.emptyIcon}
        extraActions={
          canCreate || canActivate ? (
            <PageActionsMenu>
              {canActivate && (
                <DropdownMenuItem data-page-action="catalogue" onSelect={() => catalogue.open()}>
                  <LibraryBig />
                  {t("catalogue.browse")}
                </DropdownMenuItem>
              )}
              {canCreate && (
                <>
                  <DropdownMenuItem data-page-action="import" onSelect={() => setImportOpen(true)}>
                    <Upload />
                    {t("nav.import", { ns: "common" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                    <Plus />
                    {t("list.createItem", { ns: "agents", type: typeLabel })}
                  </DropdownMenuItem>
                </>
              )}
            </PageActionsMenu>
          ) : undefined
        }
        title={title}
        breadcrumbs={[{ label: title }]}
      />
      {catalogue.value !== null && canActivate && (
        <PackageCatalogueModal type={type} onClose={catalogue.close} />
      )}
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
