// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import type { LibraryPackageItem } from "../hooks/use-library";
import type { PendingShare } from "../lib/catalogue-placement";
import { CATALOGUE_TYPE_LABEL_KEY } from "../lib/catalogue-link";
import type { DataColumn } from "./data-table";
import { CellEmpty, CellText } from "./table-cells";

export function useCatalogueSharedColumns({
  spaceNameOf,
  mayActivateIn,
  busy,
  onActivate,
}: {
  spaceNameOf: (spaceId: string) => string;
  /** The reader's verdict for switching this package on in that space. */
  mayActivateIn: (pkg: LibraryPackageItem, spaceId: string) => boolean;
  busy: boolean;
  onActivate: (pkg: LibraryPackageItem, spaceId: string) => void;
}): DataColumn<PendingShare>[] {
  const { t } = useTranslation("settings");

  return [
    {
      id: "item",
      header: t("catalogue.shared.item"),
      width: "minmax(160px,2fr)",
      cell: (share) => (
        <span className="min-w-0">
          <CellText strong>{share.pkg.name || share.pkg.id}</CellText>
          {share.pkg.description && <CellText>{share.pkg.description}</CellText>}
        </span>
      ),
    },
    {
      id: "type",
      header: t("proxies.col.type"),
      width: "minmax(80px,0.7fr)",
      tier: 2,
      cell: (share) => <CellText>{t(CATALOGUE_TYPE_LABEL_KEY[share.pkg.type])}</CellText>,
    },
    {
      id: "by",
      header: t("catalogue.shared.by"),
      width: "minmax(80px,1fr)",
      tier: 2,
      cell: (share) =>
        share.sharedBy ? (
          <CellText title={share.sharedBy}>{share.sharedBy}</CellText>
        ) : (
          <CellEmpty />
        ),
    },
    {
      id: "with",
      header: t("catalogue.shared.with"),
      width: "minmax(80px,1fr)",
      tier: 3,
      cell: (share) => <CellText strong>{spaceNameOf(share.spaceId)}</CellText>,
    },
    {
      id: "action",
      header: t("catalogue.shared.action"),
      width: "minmax(160px,1.2fr)",
      align: "end",
      control: true,
      cell: (share) => {
        const space = spaceNameOf(share.spaceId);
        // Raised above the row's link overlay, or pressing would open the sheet.
        return mayActivateIn(share.pkg, share.spaceId) ? (
          <Button
            size="sm"
            className="relative z-10"
            disabled={busy}
            onClick={() => onActivate(share.pkg, share.spaceId)}
          >
            {t("catalogue.sheet.activateIn", { space })}
          </Button>
        ) : (
          // No refused button: the reader is told who can act.
          <span className="text-muted-foreground text-xs">
            {t("catalogue.shared.noRight", { space })}
          </span>
        );
      },
    },
  ];
}
