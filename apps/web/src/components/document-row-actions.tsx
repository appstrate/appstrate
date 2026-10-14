// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Eye, Pin, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { FileDto } from "../hooks/use-files";
import { fileRunHref } from "../lib/files";
import { TableRowActions } from "./table-row-actions";

/**
 * The « … » menu of one file row, shared by the table and the compact list.
 * Each action is gated by the server-computed `capabilities`; `onPreview` is
 * absent where a click on the row already previews.
 */
export function DocumentRowActions({
  doc,
  isPending,
  showRunLink,
  onPreview,
  onDownload,
  onKeep,
  onDelete,
}: {
  doc: FileDto;
  isPending: boolean;
  showRunLink?: boolean;
  onPreview?: (doc: FileDto) => void;
  onDownload: (doc: FileDto) => void;
  onKeep: (doc: FileDto) => void;
  onDelete: (doc: FileDto) => void;
}) {
  const { t } = useTranslation(["files", "common"]);
  const runHref = showRunLink ? fileRunHref(doc) : undefined;
  const canPreview = Boolean(onPreview) && doc.capabilities.preview;
  const canKeep = doc.capabilities.keep && Boolean(doc.expiresAt);
  const hasNonDestructive = canPreview || doc.capabilities.download || Boolean(runHref) || canKeep;
  const hasMenu = hasNonDestructive || doc.capabilities.delete;

  return (
    <TableRowActions
      menuLabel={hasMenu ? t("row.moreActions", { name: doc.name }) : undefined}
      isPending={isPending}
    >
      {hasMenu ? (
        <>
          {canPreview && (
            <DropdownMenuItem onSelect={() => onPreview?.(doc)}>
              <Eye />
              {t("row.preview")}
            </DropdownMenuItem>
          )}
          {doc.capabilities.download && (
            <DropdownMenuItem onSelect={() => onDownload(doc)}>
              <Download />
              {t("row.download")}
            </DropdownMenuItem>
          )}
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
              {hasNonDestructive && <DropdownMenuSeparator />}
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
}
