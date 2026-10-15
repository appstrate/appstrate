// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format-bytes";
import type { FileDto } from "../hooks/use-files";
import { mimeKind } from "../lib/files";
import type { DataColumn } from "./data-table";
import { DocumentRowActions } from "./document-row-actions";
import { ExpiryBadge } from "./file-badges";
import { rowActionsColumn } from "./row-actions-column";
import { CellDate, CellText } from "./table-cells";

export function useDocumentColumns({
  pendingKeepId,
  showRunLink,
  onDownload,
  onKeep,
  onDelete,
}: {
  pendingKeepId: string | null;
  showRunLink?: boolean;
  onDownload: (doc: FileDto) => void;
  onKeep: (doc: FileDto) => void;
  onDelete: (doc: FileDto) => void;
}): DataColumn<FileDto>[] {
  const { t } = useTranslation(["files", "common"]);

  return [
    {
      id: "name",
      header: t("column.name"),
      width: 132,
      elastic: true,
      cell: (doc) => (
        <span className="relative z-10 truncate font-medium" title={doc.name}>
          {doc.name}
        </span>
      ),
    },
    {
      id: "purpose",
      header: t("column.purpose"),
      width: 104,
      tier: 2,
      cell: (doc) => <CellText>{t(`purpose.${doc.purpose}`)}</CellText>,
    },
    {
      id: "type",
      header: t("column.type"),
      width: 92,
      tier: 2,
      cell: (doc) => <CellText title={doc.mime}>{t(`type.${mimeKind(doc.mime)}`)}</CellText>,
    },
    {
      id: "size",
      header: t("column.size"),
      width: 72,
      tier: 3,
      align: "end",
      cell: (doc) => (
        <span className="text-muted-foreground text-xs tabular-nums">{formatBytes(doc.size)}</span>
      ),
    },
    {
      id: "created",
      header: t("column.created"),
      width: 112,
      tier: 3,
      align: "end",
      cell: (doc) => <CellDate value={doc.createdAt} granularity="datetime" />,
    },
    {
      id: "retention",
      header: t("column.retention"),
      width: 112,
      tier: 3,
      cell: (doc) => (
        <span className="text-xs">
          {doc.expiresAt ? (
            <ExpiryBadge expiresAt={doc.expiresAt} />
          ) : (
            <span className="text-muted-foreground">{t("retention.permanent")}</span>
          )}
        </span>
      ),
    },
    rowActionsColumn((doc) => (
      <DocumentRowActions
        doc={doc}
        isPending={pendingKeepId === doc.id}
        showRunLink={showRunLink}
        onDownload={onDownload}
        onKeep={onKeep}
        onDelete={onDelete}
      />
    )),
  ];
}
