// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SpaceNameOf } from "./space-name";
import { PackageSpaces, type PackageSpacesOf } from "./package-spaces";
import type { DataColumn } from "./data-table";

/** The « Espace » column of a list spanning spaces; none otherwise. Spread into a column set. */
function useSpaceColumnOf<T>(spanning: boolean, cell: (row: T) => ReactNode): DataColumn<T>[] {
  const { t } = useTranslation(["common"]);
  if (!spanning) return [];
  return [{ id: "space", header: t("table.column.space"), width: 120, elastic: true, cell }];
}

/** The column of rows that live in ONE space (runs, schedules, files). */
export function useSpaceColumn<T extends { spaceId?: string }>(spanning: boolean): DataColumn<T>[] {
  return useSpaceColumnOf<T>(spanning, (row) => (
    <SpaceNameOf spaceId={row.spaceId} className="text-muted-foreground" />
  ));
}

/** The column of package rows, each listed once for every space it is active in. */
export function usePackageSpaceColumn<T>(
  spanning: boolean,
  read: (row: T) => PackageSpacesOf,
): DataColumn<T>[] {
  return useSpaceColumnOf<T>(spanning, (row) => <PackageSpaces item={read(row)} />);
}
