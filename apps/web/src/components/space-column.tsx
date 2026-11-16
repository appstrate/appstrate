// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { SpaceTilesOf } from "./space-name";
import type { DataColumn } from "./data-table";

/** The « Espace » column of a list spanning spaces; none otherwise. Spread into a column set. */
export function useSpaceColumn<T extends { spaceId?: string; spaceIds?: string[] }>(
  spanning: boolean,
): DataColumn<T>[] {
  const { t } = useTranslation(["common"]);
  if (!spanning) return [];
  return [
    {
      id: "space",
      header: t("table.column.space"),
      width: 120,
      elastic: true,
      // A package index holds a row once for every space listing it; any other row has one space.
      cell: (row) => (
        <SpaceTilesOf
          spaceIds={row.spaceIds ?? (row.spaceId ? [row.spaceId] : [])}
          className="text-muted-foreground"
        />
      ),
    },
  ];
}
