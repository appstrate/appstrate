// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { formatBytes } from "../../lib/format-bytes";
import { bundleFileRole, type BundleFileRole } from "../../lib/bundle-file-role";
import type { PackageFileEntry } from "../../lib/package-file-tree";
import type { DataColumn } from "../data-table";
import { CellText } from "../table-cells";

const ROLE_LABEL: Record<BundleFileRole, string> = {
  manifest: "run.tabManifest",
  main: "editor.fileRole.main",
  documentation: "common:userMenu.documentation",
  "entry-point": "editor.fileRole.entryPoint",
  reference: "editor.fileRole.reference",
  script: "editor.fileRole.script",
  asset: "editor.fileRole.asset",
  other: "editor.fileRole.other",
};

export function usePackageFileColumns(
  type: PackageType,
  manifest: Record<string, unknown>,
): DataColumn<PackageFileEntry>[] {
  const { t } = useTranslation("agents");
  return [
    {
      id: "file",
      header: t("editor.bundleFileColumn"),
      width: "minmax(160px,3fr)",
      cell: (entry) => (
        <CellText strong title={entry.path}>
          {entry.path}
        </CellText>
      ),
    },
    {
      id: "type",
      header: t("log.filterType"),
      width: "minmax(100px,1fr)",
      tier: 2,
      cell: (entry) => (
        <CellText>{t(ROLE_LABEL[bundleFileRole(type, entry.path, manifest)])}</CellText>
      ),
    },
    {
      id: "size",
      header: t("editor.bundleSizeColumn"),
      width: "88px",
      align: "end",
      tier: 3,
      cell: (entry) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatBytes(entry.size)}
        </span>
      ),
    },
  ];
}
