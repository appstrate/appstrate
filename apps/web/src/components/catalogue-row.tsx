// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces of a catalogue row that the table and the card both draw:
 * the install status, and the "…" menu holding the row's deeds.
 */
import { useTranslation } from "react-i18next";
import { Check, Download, Eye } from "lucide-react";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import type { CatalogueRowState } from "./catalogue-columns";
import { canInstall } from "../lib/catalogue-install";
import { TableRowActions } from "./table-row-actions";
import type { CardItem } from "../pages/package-list";

/** "Installé ici", "Préinstallé" or "Non installé" — said as a status, not left to a missing button. */
export function CatalogueStatusBadge({ state }: { state: CatalogueRowState }) {
  const { t } = useTranslation("settings");
  if (state.everywhere) return <UIBadge variant="secondary">{t("catalogue.everywhere")}</UIBadge>;
  if (state.activeHere) {
    return (
      <UIBadge variant="success" className="gap-1">
        <Check className="size-3" />
        {t("catalogue.activeHere")}
      </UIBadge>
    );
  }
  return <UIBadge variant="outline">{t("catalogue.notInstalled")}</UIBadge>;
}

export function CatalogueRowMenu({
  item,
  state,
  spaceName,
  isActivating,
  onActivate,
  onOpen,
}: {
  item: CardItem;
  state: CatalogueRowState;
  spaceName: string;
  isActivating: boolean;
  onActivate: (item: CardItem) => void;
  onOpen: (item: CardItem) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <TableRowActions
      menuLabel={t("catalogue.moreActions", { name: item.displayName })}
      isPending={isActivating}
    >
      {canInstall(item, state) && (
        <DropdownMenuItem onSelect={() => onActivate(item)}>
          <Download />
          {t("catalogue.activateIn", { space: spaceName })}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => onOpen(item)}>
        <Eye />
        {t("catalogue.viewDetail")}
      </DropdownMenuItem>
    </TableRowActions>
  );
}
