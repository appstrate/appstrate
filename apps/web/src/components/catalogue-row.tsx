// SPDX-License-Identifier: Apache-2.0

/**
 * The deeds that act on a catalogue package itself, drawn twice with ONE list
 * of items: behind a row's "…" in the matrix, and behind the "Actions" menu of
 * the package's sheet, so no deed appears on one surface and not the other.
 * Which deeds a reader gets is `catalogueDeeds` (`lib/catalogue-gates`).
 */
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { Eye, FolderInput, Share2, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "./table-row-actions";
import type { CardItem } from "../lib/package-card-item";
import type { CatalogueDeeds } from "../lib/catalogue-gates";

interface CatalogueMenuProps {
  item: CardItem;
  deeds: CatalogueDeeds;
  spaceNameOf: (spaceId: string) => string;
  onMoveHome: (item: CardItem) => void;
  onShare: (item: CardItem) => void;
  onRevoke: (item: CardItem, spaceId: string) => void;
}

/** The items, for whichever trigger holds them. */
export function CatalogueMenuItems({
  item,
  deeds,
  spaceNameOf,
  open,
  onMoveHome,
  onShare,
  onRevoke,
}: CatalogueMenuProps & {
  /**
   * The first item: the sheet from a row, the package's own page from the
   * sheet — absent when that page is not one the reader can open here.
   */
  open?: { label: string; icon: LucideIcon; onSelect: () => void };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const OpenIcon = open?.icon;
  return (
    <>
      {open && OpenIcon && (
        <DropdownMenuItem onSelect={open.onSelect}>
          <OpenIcon />
          {open.label}
        </DropdownMenuItem>
      )}
      {/* Activating is not here: it is a switch that says WHICH space it acts
          on — a column in the matrix, "Actif ici" on the sheet. A menu item
          could only ever mean the space the app happens to be in. What remains
          are the deeds that act on the package itself. */}
      {open && (deeds.moveHome || deeds.share) && <DropdownMenuSeparator />}
      {deeds.moveHome && (
        <DropdownMenuItem onSelect={() => onMoveHome(item)}>
          <FolderInput />
          {t("packages.moveHome")}
        </DropdownMenuItem>
      )}
      {deeds.share && (
        <DropdownMenuItem onSelect={() => onShare(item)}>
          <Share2 />
          {t("packages.share")}
        </DropdownMenuItem>
      )}
      {deeds.revokeFrom.length > 0 && (
        <>
          <DropdownMenuSeparator />
          {/* Withdrawing an offer removes the package from that space, with the
              activation it backs: the placement IS the offer. */}
          {deeds.revokeFrom.map((spaceId) => (
            <DropdownMenuItem
              key={spaceId}
              variant="destructive"
              onSelect={() => onRevoke(item, spaceId)}
            >
              <X />
              {t("catalogue.revokeFrom", { space: spaceNameOf(spaceId) })}
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  );
}

/** The row's "…": its first item opens the sheet. */
export function CatalogueRowMenu({
  isPending,
  onOpen,
  ...props
}: CatalogueMenuProps & { isPending: boolean; onOpen: (item: CardItem) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <TableRowActions
      menuLabel={t("catalogue.moreActions", { name: props.item.displayName })}
      isPending={isPending}
    >
      <CatalogueMenuItems
        {...props}
        open={{ label: t("catalogue.viewDetail"), icon: Eye, onSelect: () => onOpen(props.item) }}
      />
    </TableRowActions>
  );
}
