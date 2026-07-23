// SPDX-License-Identifier: Apache-2.0

/**
 * Presentational grid tile for a single document — shared by the run-detail
 * Documents tab and the gallery page. Renders a square media area (an image
 * preview when the document is an image, the mime icon otherwise), the name,
 * size + created time, and the action row (optional run link, preview,
 * download, delete). Behavior (download, delete, gating) is
 * injected by the parent; the only fetching this component does is the
 * authenticated image preview, isolated in `DocumentTileImage` so the hook runs
 * only for eligible images.
 */

import { createElement } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ClockIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileInput,
  FileOutput,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import { isImageMime, useDocumentImageSrc } from "@appstrate/module-chat/ui";
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { cn } from "@appstrate/ui/cn";
import { formatDateField } from "../lib/markdown";
import { buildScopingHeaders } from "../lib/scoping-headers";
import { mimeIconFor, documentRunHref, documentExpiryInfo } from "../lib/documents";
import type { DocumentDto } from "../hooks/use-documents";

/**
 * Relative-expiry badge — rendered only for a document carrying a retention
 * deadline. Amber inside the 7-day warning window (or already past), muted
 * otherwise. Sub-day deadlines read in hours, everything else in whole days.
 */
function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation("documents");
  const info = documentExpiryInfo(expiresAt);
  if (!info) return null;
  const label = info.expired
    ? t("expiry.expired")
    : info.days >= 1
      ? t("expiry.inDays", { count: info.days })
      : t("expiry.inHours", { count: info.hours });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        info.soon ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
      )}
      title={label}
    >
      <ClockIcon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Render the mime's Lucide icon. `createElement` (not a PascalCase const from
 * the helper) keeps `react-hooks/static-components` happy — the rule flags a
 * component derived from a helper call during render.
 */
function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  return createElement(mimeIconFor(mime), { className });
}

/** Centered mime-icon placeholder — the non-image media, and the image fallback. */
function MimePlaceholder({ mime }: { mime: string }) {
  return (
    <div className="flex size-full items-center justify-center">
      <MimeIcon mime={mime} className="text-muted-foreground size-10" />
    </div>
  );
}

/**
 * Image branch: the authenticated cover-cropped preview, falling back to the
 * mime placeholder while the fetch is in flight or on failure (src null). Kept
 * as its own component so the fetch hook only runs for eligible images (hooks
 * can't be called conditionally). Cookie auth alone is not enough — the content
 * route resolves the org/app context from the scoping headers, like every other
 * web API call.
 */
function DocumentTileImage({ doc }: { doc: DocumentDto }) {
  const src = useDocumentImageSrc(doc.id, buildScopingHeaders);
  if (!src) return <MimePlaceholder mime={doc.mime} />;
  return <img src={src} alt={doc.name} className="size-full object-cover" />;
}

export function DocumentTile({
  doc,
  onDownload,
  onDelete,
  onKeep,
  onPreview,
  showRunLink,
  direction,
}: {
  doc: DocumentDto;
  onDownload: (id: string, name: string) => void;
  /** When provided, a delete button is rendered (visibility is the parent's call). */
  onDelete?: (doc: DocumentDto) => void;
  /**
   * When provided AND the doc still has an expiry, a "keep" (pin) button is
   * rendered that clears the retention deadline. Visibility is the parent's call.
   */
  onKeep?: (doc: DocumentDto) => void;
  /** When provided and the doc is previewable, a preview button is rendered. */
  onPreview?: (doc: DocumentDto) => void;
  /** Show the producing-agent label + a link to its run (gallery). */
  showRunLink?: boolean;
  /** Run tab only: whether this run consumed the doc (input) or produced it (output). */
  direction?: "input" | "output";
}) {
  const { t } = useTranslation("documents");
  const runHref = showRunLink ? documentRunHref(doc) : undefined;

  const canPreview = !!onPreview && doc.previewable;
  // Media click mirrors the primary action: preview when available, else the
  // authenticated download when the content is reachable.
  const activate = canPreview
    ? () => onPreview(doc)
    : doc.downloadable
      ? () => onDownload(doc.id, doc.name)
      : undefined;
  const activateLabel = canPreview ? t("row.preview") : t("row.download");

  // Gate the image fetch on downloadable — an un-downloadable doc (another
  // member's upload) would 403, so fall straight to the mime placeholder.
  const showImage = doc.downloadable && isImageMime(doc.mime);

  const media = (
    <>
      {showImage ? <DocumentTileImage doc={doc} /> : <MimePlaceholder mime={doc.mime} />}
      {direction ? (
        <span
          className="bg-background/80 text-muted-foreground absolute top-1 left-1 rounded border p-1 backdrop-blur"
          title={t(direction === "output" ? "row.outputDocument" : "row.inputDocument")}
        >
          {direction === "output" ? (
            <FileOutput className="size-3.5" />
          ) : (
            <FileInput className="size-3.5" />
          )}
        </span>
      ) : null}
    </>
  );

  return (
    <div className="border-border bg-card flex flex-col overflow-hidden rounded-lg border">
      {activate ? (
        <button
          type="button"
          onClick={activate}
          title={activateLabel}
          aria-label={activateLabel}
          className="bg-muted hover:bg-muted/70 relative block aspect-square w-full"
        >
          {media}
        </button>
      ) : (
        <div className="bg-muted relative aspect-square w-full">{media}</div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <span className="truncate text-sm font-medium" title={doc.name}>
          {doc.name}
        </span>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="tabular-nums">{formatBytes(doc.size)}</span>
          <span aria-hidden>·</span>
          <span>{formatDateField(doc.createdAt, "datetime")}</span>
          {doc.expiresAt ? (
            <>
              <span aria-hidden>·</span>
              <ExpiryBadge expiresAt={doc.expiresAt} />
            </>
          ) : null}
        </div>

        <div className="mt-auto flex items-center justify-end gap-1 pt-1">
          {runHref ? (
            <Button
              asChild
              variant="ghost"
              size="icon"
              // The anchor doesn't inherit the buttons' muted color — pin it so
              // the run link matches the sibling action icons.
              className="text-muted-foreground size-8"
              title={t("row.openRun")}
              aria-label={t("row.openRun")}
            >
              <Link to={runHref}>
                <ExternalLinkIcon className="size-4" />
              </Link>
            </Button>
          ) : null}
          {canPreview ? (
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
          {onKeep && doc.expiresAt ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-8"
              title={t("row.keep")}
              aria-label={t("row.keep")}
              onClick={() => onKeep(doc)}
            >
              <PinIcon className="size-4" />
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
    </div>
  );
}
