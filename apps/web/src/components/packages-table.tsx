// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { CollectionState } from "./collection";
import { DataTable, type DataColumn } from "./data-table";
import { packageDetailPath } from "../lib/package-paths";
import type { CardItem } from "../pages/package-list";

export function PackagesTable({
  items,
  columns,
  rowAction,
  ...state
}: {
  items: CardItem[];
  /** From {@link usePackageColumns}, minus whatever the reader hid. */
  columns: DataColumn<CardItem>[];
  /**
   * Read the package HERE rather than on its own page. The catalogue does
   * this: its page would throw away the panel and claim a space the package is
   * not in. When set it replaces the row's link, never doubles it.
   */
  rowAction?: (item: CardItem) => void;
} & CollectionState) {
  const { t } = useTranslation(["agents", "common"]);

  // The same state `CardGrid` takes, forwarded whole: the two bodies answer it
  // through the same `collectionVerdict`, so a caller can hand either one the
  // same props and branch on nothing.
  return (
    <DataTable
      tableId="packages"
      label={t("list.tableLabel")}
      columns={columns}
      rows={items}
      rowKey={(item) => item.id}
      rowHref={rowAction ? undefined : (item) => packageDetailPath(item.type, item.id)}
      rowAction={rowAction}
      rowLabel={(item) => item.displayName}
      columnMode="scroll"
      {...state}
    />
  );
}
