// SPDX-License-Identifier: Apache-2.0

/**
 * The deeds that act on a catalogue package itself, drawn twice with ONE list
 * of items: behind a row's "…" in the matrix, and behind the "Actions" menu of
 * the package's sheet. Two copies of the list would be two places for a deed
 * to appear on one surface and not the other — which is how the sheet came to
 * offer none of them.
 */
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { Eye, FolderInput, Share2, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "./table-row-actions";
import type { CardItem } from "../pages/package-list";

interface CatalogueMenuProps {
  item: CardItem;
  /** `home_writable`: moving a package is the same authority as editing it. */
  homeWritable: boolean;
  /** `home_shareable`: a third verb on the home space, granted on its own. */
  homeShareable: boolean;
  /** Spaces the package reaches through a share, so each can be withdrawn. */
  sharedSpaces: { id: string; name: string }[];
  onMoveHome: (item: CardItem) => void;
  onShare: (item: CardItem) => void;
  onRevoke: (item: CardItem, spaceId: string) => void;
}

/** The items, for whichever trigger holds them. */
export function CatalogueMenuItems({
  item,
  homeWritable,
  homeShareable,
  sharedSpaces,
  open,
  onMoveHome,
  onShare,
  onRevoke,
}: CatalogueMenuProps & {
  /** The first item: the sheet from a row, the package's own page from the sheet. */
  open: { label: string; icon: LucideIcon; onSelect: () => void };
}) {
  const { t } = useTranslation(["settings", "common"]);
  const OpenIcon = open.icon;
  return (
    <>
      <DropdownMenuItem onSelect={open.onSelect}>
        <OpenIcon />
        {open.label}
      </DropdownMenuItem>
      {/* Activating is not here: it is a switch that says WHICH space it acts
          on — a column in the matrix, "Actif ici" on the sheet. A menu item
          could only ever mean the space the app happens to be in. What remains
          are the deeds that act on the package itself. */}
      {(homeWritable || homeShareable) && <DropdownMenuSeparator />}
      {homeWritable && (
        <DropdownMenuItem onSelect={() => onMoveHome(item)}>
          <FolderInput />
          {t("packages.moveHome")}
        </DropdownMenuItem>
      )}
      {homeShareable && (
        <DropdownMenuItem onSelect={() => onShare(item)}>
          <Share2 />
          {t("packages.share")}
        </DropdownMenuItem>
      )}
      {homeShareable && sharedSpaces.length > 0 && (
        <>
          <DropdownMenuSeparator />
          {/* Withdrawing an offer removes the package from that space, with the
              activation it backs: the placement WAS the offer. */}
          {sharedSpaces.map((space) => (
            <DropdownMenuItem
              key={space.id}
              className="text-destructive focus:text-destructive"
              onSelect={() => onRevoke(item, space.id)}
            >
              <X />
              {t("catalogue.revokeFrom", { space: space.name })}
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
