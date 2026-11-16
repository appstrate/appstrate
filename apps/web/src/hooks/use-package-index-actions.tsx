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
import { useSpaceAction } from "./use-space-action";

/**
 * A package index's deeds: browse the catalogue, import, create. Creating — by hand, with the
 * chat or by import — is a write on the type, as its routes are; the import names the type, so
 * the server refuses an archive of another one. Each is offered where a space grants it; the
 * dialogs open in the working space, which the action entered when it asked for one. Render
 * `actionsMenu` in the header and `pickers` anywhere.
 */
export function usePackageIndexActions(type: PackageType, createLabel: string) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const write = packagePermission(type, "write");
  const create = useSpaceAction({ permission: write });
  const browse = useSpaceAction({ permission: spacePackagePermission(type, "activate") });
  const canCreate = can(write);
  const creation = useCreationHandoff(type, canCreate);
  const [importing, setImporting] = useState(false);

  const createAction: MenuAction = {
    id: "create",
    label: createLabel,
    icon: Plus,
    onSelect: () => create.run(creation.open),
    hidden: !create.offered,
  };
  const actionsMenu = (
    <PageActionsMenu
      actions={[
        {
          id: "catalogue",
          label: t("settings:catalogue.browse"),
          icon: LibraryBig,
          ...browse.link(catalogueHref(type)),
          hidden: !browse.offered,
        },
        {
          id: "import",
          label: t("common:nav.import"),
          icon: Upload,
          onSelect: () => create.run(() => setImporting(true)),
          hidden: !create.offered,
        },
        createAction,
      ]}
    />
  );
  const pickers = (
    <>
      {create.picker}
      {browse.picker}
    </>
  );
  return { canCreate, creation, importing, setImporting, createAction, actionsMenu, pickers };
}
