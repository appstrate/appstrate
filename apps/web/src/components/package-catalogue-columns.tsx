// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue's columns: the LIST's own column set, minus what only makes
 * sense for a package already in the space, plus the one deed a catalogue has.
 *
 * Reusing `usePackageColumns` is the point — a package reads the same way
 * wherever it is drawn, so the catalogue is the same table as the page behind
 * it. What it drops is the agent's running state and its run button: neither
 * says anything about a package this space cannot use yet.
 *
 * Out of the modal so `column-tiers.test.tsx` can measure it.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { usePackageColumns } from "./packages-table";
import type { CardItem } from "../pages/package-list";

export function usePackageCatalogueColumns({
  type,
  isActivating,
  onActivate,
}: {
  type: PackageType;
  isActivating: boolean;
  onActivate: (item: CardItem) => void;
}): DataColumn<CardItem>[] {
  const { t } = useTranslation(["settings", "agents", "common"]);

  return [
    ...usePackageColumns(type).filter((column) => column.id !== "state" && column.id !== "actions"),
    {
      id: "activate",
      header: "",
      width: "112px",
      align: "end",
      cell: (item) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isActivating}
          onClick={() => onActivate(item)}
        >
          {t("catalogue.activate")}
        </Button>
      ),
    },
  ];
}
