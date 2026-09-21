// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces of a catalogue row that the table and the card both draw:
 * the install status, and the "…" menu holding the row's deeds.
 */
import { useTranslation } from "react-i18next";
import { Check, Eye, FolderInput, Share2, X } from "lucide-react";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { CatalogueRowState } from "./catalogue-columns";
import { TableRowActions } from "./table-row-actions";
import type { CardItem } from "../pages/package-list";

/**
 * Which of the three states this row is in, in the space on screen.
 *
 * Said as a status rather than left to the absence of a button, and said in the
 * placement model's own words: a package is PLACED (by its home or by a share)
 * and separately switched on, so "offered" is a placement nobody has switched
 * on yet — not an invitation waiting for an answer.
 */
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
  if (state.offeredHere) return <UIBadge variant="warning">{t("catalogue.offeredHere")}</UIBadge>;
  if (state.placedHere) return <UIBadge variant="outline">{t("catalogue.inactiveHere")}</UIBadge>;
  return <UIBadge variant="outline">{t("catalogue.notPlaced")}</UIBadge>;
}

export function CatalogueRowMenu({
  item,
  homeWritable,
  homeShareable,
  sharedSpaces,
  isPending,
  onOpen,
  onMoveHome,
  onShare,
  onRevoke,
}: {
  item: CardItem;
  /** `home_writable`: moving a package is the same authority as editing it. */
  homeWritable: boolean;
  /** `home_shareable`: a third verb on the home space, granted on its own. */
  homeShareable: boolean;
  /** Spaces the package reaches through a share, so each can be withdrawn. */
  sharedSpaces: { id: string; name: string }[];
  isPending: boolean;
  onOpen: (item: CardItem) => void;
  onMoveHome: (item: CardItem) => void;
  onShare: (item: CardItem) => void;
  onRevoke: (item: CardItem, spaceId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <TableRowActions
      menuLabel={t("catalogue.moreActions", { name: item.displayName })}
      isPending={isPending}
    >
      <DropdownMenuItem onSelect={() => onOpen(item)}>
        <Eye />
        {t("catalogue.viewDetail")}
      </DropdownMenuItem>
      {/* Activating is not here: it is the switch in each space's column, which
          says WHICH space it would act on. A menu item could only ever mean the
          space the app happens to be in, which is the ambiguity those columns
          removed. What remains are the deeds that act on the package itself. */}
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
    </TableRowActions>
  );
}
