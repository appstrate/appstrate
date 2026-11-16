// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Download, ExternalLink, Eye, Pin, Trash2 } from "lucide-react";
import type { FileDto } from "../hooks/use-files";
import { fileRunHref } from "../lib/files";
import { useSpaceLink } from "../hooks/use-current-space";
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
  const linkInSpace = useSpaceLink();
  const runPath = showRunLink ? fileRunHref(doc) : undefined;
  // A run of another space (a list spanning several) names it: the run detail enters it.
  const runHref = runPath && linkInSpace(runPath, doc.spaceId);

  return (
    <TableRowActions
      menuLabel={t("row.moreActions", { name: doc.name })}
      isPending={isPending}
      actions={[
        {
          id: "preview",
          label: t("row.preview"),
          icon: Eye,
          onSelect: () => onPreview?.(doc),
          hidden: !(Boolean(onPreview) && doc.capabilities.preview),
        },
        {
          id: "download",
          label: t("common:btn.download"),
          icon: Download,
          onSelect: () => onDownload(doc),
          hidden: !doc.capabilities.download,
        },
        {
          id: "run",
          label: t("row.openRun"),
          icon: ExternalLink,
          to: runHref,
          hidden: !runHref,
        },
        {
          id: "keep",
          label: t("row.keep"),
          icon: Pin,
          onSelect: () => onKeep(doc),
          hidden: !(doc.capabilities.keep && Boolean(doc.expiresAt)),
        },
        {
          id: "delete",
          label: t("common:btn.delete"),
          icon: Trash2,
          onSelect: () => onDelete(doc),
          destructive: true,
          hidden: !doc.capabilities.delete,
        },
      ]}
    />
  );
}
