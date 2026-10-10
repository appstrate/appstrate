// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation, useNavigate } from "react-router-dom";
import { catalogueHref } from "../lib/catalogue-link";
import { useTranslation } from "react-i18next";
import { LibraryBig, Plug, Plus, Upload, Wrench } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useModalParam } from "../hooks/use-modal-param";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { type CardItem, PackageTab } from "./package-list";
import { packageNewPath } from "../lib/package-paths";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import { openAsModal } from "../lib/modal-route";
import { usePermissions } from "../hooks/use-permissions";
import {
  PACKAGE_WRITE_PERMISSIONS,
  packagePermission,
  spacePackagePermission,
} from "@appstrate/core/permissions";

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
  const { data: rawItems, isLoading } = usePackageList(type);
  const { can } = usePermissions();
  const importParam = useModalParam("import");
  const navigate = useNavigate();
  const location = useLocation();
  // Creating is a write on the package type, as its route is.
  const canCreate = can(packagePermission(type, "write"));
  // Import is type-agnostic: any package write opens it, the door re-checks the type.
  const canImport = PACKAGE_WRITE_PERMISSIONS.some(can);
  const creation = useCreationHandoff(type, canCreate);
  const canActivate = can(spacePackagePermission(type, "activate"));

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
        emptyHint={<SpaceLibraryHint type={type} />}
        emptyIcon={presentation.emptyIcon}
        extraActions={
          canCreate || canImport || canActivate ? (
            <PageActionsMenu>
              {canActivate && (
                <DropdownMenuItem asChild data-page-action="catalogue">
                  <Link
                    // A local MCP server is installed through its integration.
                    to={catalogueHref(type)}
                    state={openAsModal(location)}
                  >
                    <LibraryBig />
                    {t("catalogue.browse")}
                  </Link>
                </DropdownMenuItem>
              )}
              {canImport && (
                <DropdownMenuItem data-page-action="import" onSelect={() => importParam.open()}>
                  <Upload />
                  {t("nav.import", { ns: "common" })}
                </DropdownMenuItem>
              )}
              {canCreate && (
                <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                  <Plus />
                  {t("list.createItem", { ns: "agents", type: typeLabel })}
                </DropdownMenuItem>
              )}
            </PageActionsMenu>
          ) : undefined
        }
        title={title}
        breadcrumbs={[{ label: title }]}
      />
      <ImportModal open={importParam.value !== null} onClose={importParam.close} />
      {creation.isOpen && (
        <CreationHandoffModal
          resource={type}
          onClose={creation.close}
          onManual={() => {
            if (manualCreation === "import") {
              // Handing over from the chooser: one navigation, never two modals.
              importParam.open("1", "create");
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
