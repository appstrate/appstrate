// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useSpaceLabelOf } from "../hooks/use-spaces";
import type { DataColumn } from "./data-table";

/** The « Espace » column of a list spanning spaces; none otherwise. Spread into a column set. */
export function useSpaceColumn<T extends { spaceId?: string }>(spanning: boolean): DataColumn<T>[] {
  const { t } = useTranslation(["common"]);
  const spaceLabelOf = useSpaceLabelOf();
  if (!spanning) return [];
  return [
    {
      id: "space",
      header: t("toolbar.space"),
      width: 120,
      elastic: true,
      cell: (row) => (
        <span className="text-muted-foreground truncate text-xs">{spaceLabelOf(row.spaceId)}</span>
      ),
    },
  ];
}
