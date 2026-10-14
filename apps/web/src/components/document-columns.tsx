// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format-bytes";
import type { FileDto } from "../hooks/use-files";
import { mimeKind } from "../lib/files";
import { formatDateField } from "../lib/format-date";
import type { DataColumn } from "./data-table";
import { DocumentRowActions } from "./document-row-actions";
import { ExpiryBadge } from "./file-tile";

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
      width: "minmax(132px,1.4fr)",
      cell: (doc) => (
        <span className="relative z-10 truncate font-medium" title={doc.name}>
          {doc.name}
        </span>
      ),
    },
    {
      id: "purpose",
      header: t("column.purpose"),
      width: "104px",
      tier: 2,
      cell: (doc) => (
        <span className="text-muted-foreground truncate text-xs">
          {t(`purpose.${doc.purpose}`)}
        </span>
      ),
    },
    {
      id: "type",
      header: t("column.type"),
      width: "92px",
      tier: 2,
      cell: (doc) => (
        <span className="text-muted-foreground relative z-10 truncate text-xs" title={doc.mime}>
          {t(`type.${mimeKind(doc.mime)}`)}
        </span>
      ),
    },
    {
      id: "size",
      header: t("column.size"),
      width: "72px",
      tier: 3,
      align: "end",
      cell: (doc) => (
        <span className="text-muted-foreground text-xs tabular-nums">{formatBytes(doc.size)}</span>
      ),
    },
    {
      id: "created",
      header: t("column.created"),
      width: "112px",
      tier: 3,
      cell: (doc) => (
        <span className="text-muted-foreground text-xs">
          {formatDateField(doc.createdAt, "datetime")}
        </span>
      ),
    },
    {
      id: "retention",
      header: t("column.retention"),
      width: "112px",
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
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (doc) => (
        <DocumentRowActions
          doc={doc}
          isPending={pendingKeepId === doc.id}
          showRunLink={showRunLink}
          onDownload={onDownload}
          onKeep={onKeep}
          onDelete={onDelete}
        />
      ),
    },
  ];
}
