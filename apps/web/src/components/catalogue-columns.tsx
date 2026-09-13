// SPDX-License-Identifier: Apache-2.0

/**
 * The three columns the catalogue adds to the package table: the tick, where a
 * package is already active, and the deed.
 *
 * "Where it is already active" is the column this screen cannot do without.
 * There is no organisation-level install in this product — a package is in the
 * org's catalogue, and then it is switched on space by space — so "activate"
 * with nothing beside it never said WHERE. Now the row says where it already
 * runs, and the button names the space it would add.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import type { DataColumn } from "./data-table";
import type { CardItem } from "../pages/package-list";

/** What the catalogue knows about one row beyond the package itself. */
export interface CatalogueRowState {
  /** Names of the spaces this caller can see where the package is active. */
  activeIn: string[];
  /** Active in the space on screen: there is nothing left to do here. */
  activeHere: boolean;
  /**
   * Available in every space without being switched on at all — what a system
   * agent, skill or MCP server is. An integration is not: it has a real switch.
   */
  everywhere: boolean;
}

export function useCatalogueSelectColumn({
  selected,
  allSelected,
  selectable,
  onToggle,
  onToggleAll,
}: {
  selected: ReadonlySet<string>;
  allSelected: boolean;
  /** A row with nothing to activate cannot be part of a bulk activation. */
  selectable: (item: CardItem) => boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}): DataColumn<CardItem> {
  const { t } = useTranslation("settings");

  return {
    id: "select",
    header: t("catalogue.selectColumn"),
    headerNode: (
      <Checkbox
        checked={allSelected}
        onCheckedChange={onToggleAll}
        aria-label={t("catalogue.selectAll")}
      />
    ),
    width: "36px",
    // Tier two, so the deed can hold tier one. This table SCROLLS rather than
    // dropping columns (`columnMode="scroll"`), so the tier decides the width
    // the narrow table must reserve before it scrolls, not what is hidden: the
    // first thing in view should be what the row IS and whether it can be
    // switched on, with bulk selection a scroll away rather than the reverse.
    tier: 2,
    control: true,
    cell: (item) =>
      selectable(item) ? (
        // Raised above the row's link overlay, or ticking would open the package.
        <span className="relative z-10 flex">
          <Checkbox
            checked={selected.has(item.id)}
            onCheckedChange={() => onToggle(item.id)}
            aria-label={t("catalogue.selectOne", { name: item.displayName })}
          />
        </span>
      ) : null,
  };
}

export function useCatalogueActiveColumn(
  stateOf: (item: CardItem) => CatalogueRowState,
): DataColumn<CardItem> {
  const { t } = useTranslation("settings");

  return {
    id: "activeIn",
    header: t("catalogue.column.activeIn"),
    width: "minmax(140px,1fr)",
    // The other spaces are context, not the deed: they wait for the width.
    tier: 2,
    cell: (item) => {
      const state = stateOf(item);
      if (state.everywhere) {
        return <span className="text-muted-foreground text-xs">{t("catalogue.everywhere")}</span>;
      }
      if (state.activeIn.length === 0) {
        return <span className="text-muted-foreground/50">—</span>;
      }
      return (
        <span className="text-muted-foreground truncate text-xs" title={state.activeIn.join(", ")}>
          {state.activeIn.join(" · ")}
        </span>
      );
    },
  };
}

export function useCatalogueActivateColumn({
  spaceName,
  isActivating,
  stateOf,
  onActivate,
}: {
  spaceName: string;
  isActivating: boolean;
  stateOf: (item: CardItem) => CatalogueRowState;
  onActivate: (item: CardItem) => void;
}): DataColumn<CardItem> {
  const { t } = useTranslation("settings");

  return {
    id: "activate",
    header: "",
    width: "112px",
    align: "end",
    // Tier ONE, unlike a list's row action: this column is both the deed and
    // the answer to "is it already on here?", which is the whole question a
    // catalogue row raises. Name plus this one is 300px, inside the budget.
    control: true,
    cell: (item) => {
      const state = stateOf(item);
      if (state.everywhere) return null;
      if (state.activeHere) {
        return <span className="text-muted-foreground text-xs">{t("catalogue.activeHere")}</span>;
      }
      return (
        <span className="relative z-10">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isActivating}
            title={t("catalogue.activateIn", { space: spaceName })}
            onClick={() => onActivate(item)}
          >
            {t("catalogue.activate")}
          </Button>
        </span>
      );
    },
  };
}
