// SPDX-License-Identifier: Apache-2.0

/**
 * The two columns the organisation's catalogue adds to the package table: a
 * tick at the head of the row, and the one deed a catalogue has at the end.
 *
 * Everything between them is the list's own column set, unchanged — a package
 * reads the same way wherever it is drawn, so the catalogue borrows the table
 * rather than inventing one.
 *
 * The per-row activation waits for tier two. At a phone's width the tick and
 * the bar's "activate the selection" do the same job in the room there is,
 * which is what the tier budget leaves once identity and selection are drawn.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import type { DataColumn } from "./data-table";
import type { CardItem } from "../pages/package-list";

export function useCatalogueSelectColumn({
  selected,
  allSelected,
  onToggle,
  onToggleAll,
}: {
  selected: ReadonlySet<string>;
  allSelected: boolean;
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
    control: true,
    cell: (item) => (
      // Raised above the row's link overlay, or ticking would open the package.
      <span className="relative z-10 flex">
        <Checkbox
          checked={selected.has(item.id)}
          onCheckedChange={() => onToggle(item.id)}
          aria-label={t("catalogue.selectOne", { name: item.displayName })}
        />
      </span>
    ),
  };
}

export function useCatalogueActivateColumn({
  isActivating,
  onActivate,
}: {
  isActivating: boolean;
  onActivate: (item: CardItem) => void;
}): DataColumn<CardItem> {
  const { t } = useTranslation("settings");

  return {
    id: "activate",
    header: "",
    width: "112px",
    align: "end",
    tier: 2,
    control: true,
    cell: (item) => (
      <span className="relative z-10">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isActivating}
          onClick={() => onActivate(item)}
        >
          {t("catalogue.activate")}
        </Button>
      </span>
    ),
  };
}
