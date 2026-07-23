// SPDX-License-Identifier: Apache-2.0

/**
 * Presentational row for a single document — shared by the run-detail Documents
 * tab and the gallery page. Renders the mime icon, name, size, created time, an
 * optional producing-agent label + run link, and download / delete actions.
 * All behavior (download, delete, gating) is injected by the parent; this
 * component holds no data-fetching state.
 */

import { createElement } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DownloadIcon, ExternalLinkIcon, EyeIcon, Trash2Icon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { formatDateField } from "../lib/markdown";
import { mimeIconFor, documentRunHref } from "../lib/documents";
import type { DocumentDto } from "../hooks/use-documents";

/**
 * Render the mime's Lucide icon. `createElement` (not a PascalCase const from
 * the helper) keeps `react-hooks/static-components` happy — the rule flags a
 * component derived from a helper call during render.
 */
function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  return createElement(mimeIconFor(mime), { className });
}

export function DocumentRow({
  doc,
  onDownload,
  onDelete,
  onPreview,
  showRunLink,
}: {
  doc: DocumentDto;
  onDownload: (id: string, name: string) => void;
  /** When provided, a delete button is rendered (visibility is the parent's call). */
  onDelete?: (doc: DocumentDto) => void;
  /** When provided and the doc is previewable, a preview button is rendered. */
  onPreview?: (doc: DocumentDto) => void;
  /** Show the producing-agent label + a link to its run (gallery). */
  showRunLink?: boolean;
}) {
  const { t } = useTranslation("documents");
  const runHref = showRunLink ? documentRunHref(doc) : undefined;

  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
      <MimeIcon mime={doc.mime} className="text-muted-foreground size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium" title={doc.name}>
            {doc.name}
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="tabular-nums">{formatBytes(doc.size)}</span>
          <span aria-hidden>·</span>
          <span>{formatDateField(doc.createdAt, "datetime")}</span>
          {showRunLink && doc.packageId ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-mono">{doc.packageId}</span>
            </>
          ) : null}
          {runHref ? (
            <Link
              to={runHref}
              className="hover:text-foreground inline-flex items-center gap-1"
              title={t("row.openRun")}
            >
              <ExternalLinkIcon className="size-3" />
              {t("row.run")}
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onPreview && doc.previewable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={t("row.preview")}
            aria-label={t("row.preview")}
            onClick={() => onPreview(doc)}
          >
            <EyeIcon className="size-4" />
          </Button>
        ) : null}
        {doc.downloadable ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={t("row.download")}
            aria-label={t("row.download")}
            onClick={() => onDownload(doc.id, doc.name)}
          >
            <DownloadIcon className="size-4" />
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive size-8"
            title={t("row.delete")}
            aria-label={t("row.delete")}
            onClick={() => onDelete(doc)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
