// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Pin, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { formatBytes } from "@appstrate/core/format";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DocumentDto } from "../hooks/use-documents";
import { documentExpiryInfo, documentRunHref } from "../lib/documents";
import { formatDateField } from "../lib/markdown";
import type { DataColumn } from "./data-table";
import { TableRowActions } from "./table-row-actions";

function mimeKind(mime: string): string {
  const normalized = mime.split(";", 1)[0]?.toLowerCase() ?? mime.toLowerCase();
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/csv") return "csv";
  if (normalized.includes("json")) return "json";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("text/")) return "text";
  if (
    normalized.includes("zip") ||
    normalized.includes("gzip") ||
    normalized.includes("tar") ||
    normalized.includes("compressed")
  )
    return "archive";
  if (normalized.includes("spreadsheet") || normalized.includes("excel")) return "spreadsheet";
  return "file";
}

export function useDocumentColumns({
  pendingKeepId,
  showRunLink,
  onDownload,
  onKeep,
  onDelete,
}: {
  pendingKeepId: string | null;
  showRunLink?: boolean;
  onDownload: (doc: DocumentDto) => void;
  onKeep: (doc: DocumentDto) => void;
  onDelete: (doc: DocumentDto) => void;
}): DataColumn<DocumentDto>[] {
  const { t } = useTranslation(["documents", "common"]);

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
      cell: (doc) => {
        const expiry = documentExpiryInfo(doc.expiresAt);
        if (!expiry)
          return <span className="text-muted-foreground text-xs">{t("retention.permanent")}</span>;
        const label = expiry.expired
          ? t("expiry.expired")
          : expiry.days >= 1
            ? t("expiry.inDays", { count: expiry.days })
            : t("expiry.inHours", { count: expiry.hours });
        return (
          <span className={expiry.soon ? "text-warning text-xs" : "text-muted-foreground text-xs"}>
            {label}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (doc) => {
        const runHref = showRunLink ? documentRunHref(doc) : undefined;
        const canKeep = doc.capabilities.keep && Boolean(doc.expiresAt);
        const hasMenu = Boolean(runHref || canKeep || doc.capabilities.delete);

        return (
          <TableRowActions
            primary={
              doc.capabilities.download
                ? {
                    label: t("row.download"),
                    icon: Download,
                    onSelect: () => onDownload(doc),
                  }
                : undefined
            }
            menuLabel={hasMenu ? t("row.moreActions", { name: doc.name }) : undefined}
            isPending={pendingKeepId === doc.id}
            pendingLabel={t("common:loading")}
          >
            {hasMenu ? (
              <>
                {runHref && (
                  <DropdownMenuItem asChild>
                    <Link to={runHref}>
                      <ExternalLink />
                      {t("row.openRun")}
                    </Link>
                  </DropdownMenuItem>
                )}
                {canKeep && (
                  <DropdownMenuItem onSelect={() => onKeep(doc)}>
                    <Pin />
                    {t("row.keep")}
                  </DropdownMenuItem>
                )}
                {doc.capabilities.delete && (
                  <>
                    {(runHref || canKeep) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onSelect={() => onDelete(doc)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 />
                      {t("row.delete")}
                    </DropdownMenuItem>
                  </>
                )}
              </>
            ) : undefined}
          </TableRowActions>
        );
      },
    },
  ];
}
