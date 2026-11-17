// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, Plus, Upload } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { packagePermission, spacePackagePermission } from "@appstrate/core/permissions";
import { PageActionsMenu } from "../components/page-actions-menu";
import { catalogueHref } from "../lib/catalogue-link";
import type { MenuAction } from "../lib/menu-action";
import { useCreationHandoff } from "./use-creation-handoff";
import { usePermissions } from "./use-permissions";
import { useSpaceAction, useSpacesFor } from "./use-space-action";

/**
 * A package index's deeds: browse the catalogue, import, create — each a write on the type,
 * offered where a space grants it and opened in the space the action entered.
 */
export function usePackageIndexActions(type: PackageType, createLabel: string) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const write = packagePermission(type, "write");
  const create = useSpaceAction({ permission: write });
  const browse = useSpacesFor({ permission: spacePackagePermission(type, "activate") });
  const canCreate = can(write);
  const creation = useCreationHandoff(type, canCreate);
  const [importing, setImporting] = useState(false);

  const createAction: MenuAction = {
    id: "create",
    label: createLabel,
    icon: Plus,
    onSelect: () => create.run(creation.open),
    inSpaces: create.choose(t("common:spaceChoice.create"), creation.open),
    hidden: !create.offered,
  };
  const openImport = () => setImporting(true);
  const actionsMenu = (
    <PageActionsMenu
      actions={[
        {
          id: "catalogue",
          label: t("settings:catalogue.browse"),
          icon: LibraryBig,
          to: catalogueHref(type),
          hidden: !browse.offered,
        },
        {
          id: "import",
          label: t("common:nav.import"),
          icon: Upload,
          onSelect: () => create.run(openImport),
          inSpaces: create.choose(t("common:spaceChoice.import"), openImport),
          hidden: !create.offered,
        },
        createAction,
      ]}
    />
  );
  return { canCreate, creation, importing, setImporting, createAction, actionsMenu };
}
