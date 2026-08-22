// SPDX-License-Identifier: Apache-2.0

/**
 * Presentational grid tile for a single file — shared by the run-detail
 * Files tab and the gallery page. Renders a square media area (an image
 * preview when the file is an image, the mime icon otherwise), the name,
 * size + created time, and the action row (optional run link, preview,
 * download, delete). Behavior (download, delete, gating) is
 * injected by the parent; the only fetching this component does is the
 * authenticated image preview, isolated in `FileTileImage` so the hook runs
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
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { cn } from "@appstrate/ui/cn";
import { formatDateField } from "../lib/format-date";
import { isImageMime, mimeIconFor, fileRunHref, fileExpiryInfo } from "../lib/files";
import { useFileImageSrc, type FileDto } from "../hooks/use-files";

/**
 * Relative-expiry badge — rendered only for a file carrying a retention
 * deadline. Amber inside the 7-day warning window (or already past), muted
 * otherwise. Sub-day deadlines read in hours, everything else in whole days.
 */
function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation("files");
  const info = fileExpiryInfo(expiresAt);
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
 * can't be called conditionally).
 */
function FileTileImage({ file }: { file: FileDto }) {
  const src = useFileImageSrc(file.id);
  if (!src) return <MimePlaceholder mime={file.mime} />;
  return <img src={src} alt={file.name} className="size-full object-cover" />;
}

export function FileTile({
  file,
  onDownload,
  onDelete,
  onKeep,
  onPreview,
  showRunLink,
  direction,
}: {
  file: FileDto;
  onDownload: (id: string, name: string) => void;
  /** When provided, a delete button is rendered (visibility is the parent's call). */
  onDelete?: (file: FileDto) => void;
  /**
   * When provided AND the file still has an expiry, a "keep" (pin) button is
   * rendered that clears the retention deadline. Visibility is the parent's call.
   */
  onKeep?: (file: FileDto) => void;
  /** When provided and the file is previewable, a preview button is rendered. */
  onPreview?: (file: FileDto) => void;
  /** Show the producing-agent label + a link to its run (gallery). */
  showRunLink?: boolean;
  /** Run tab only: whether this run consumed the file (input) or produced it (output). */
  direction?: "input" | "output";
}) {
  const { t } = useTranslation("files");
  const runHref = showRunLink ? fileRunHref(file) : undefined;
  // Every affordance is driven by the server-computed capabilities (the single
  // source), not client-side guessing: `download`/`preview` gate the media
  // actions, `keep`/`delete` gate the lifecycle buttons.
  const caps = file.capabilities;

  const canPreview = !!onPreview && caps.preview;
  // Media click mirrors the primary action: preview when available, else the
  // authenticated download when the content is reachable.
  const activate = canPreview
    ? () => onPreview(file)
    : caps.download
      ? () => onDownload(file.id, file.name)
      : undefined;
  const activateLabel = canPreview ? t("row.preview") : t("row.download");

  // Gate the image fetch on download — an un-downloadable file (another member's
  // upload) would 403, so fall straight to the mime placeholder.
  const showImage = caps.download && isImageMime(file.mime);

  const media = (
    <>
      {showImage ? <FileTileImage file={file} /> : <MimePlaceholder mime={file.mime} />}
      {direction ? (
        <span
          className="bg-background/80 text-muted-foreground absolute top-1 left-1 rounded border p-1 backdrop-blur"
          title={t(direction === "output" ? "row.outputFile" : "row.inputFile")}
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
        <span className="truncate text-sm font-medium" title={file.name}>
          {file.name}
        </span>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="tabular-nums">{formatBytes(file.size)}</span>
          <span aria-hidden>·</span>
          <span>{formatDateField(file.createdAt, "datetime")}</span>
          {file.expiresAt ? (
            <>
              <span aria-hidden>·</span>
              <ExpiryBadge expiresAt={file.expiresAt} />
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
              onClick={() => onPreview(file)}
            >
              <EyeIcon className="size-4" />
            </Button>
          ) : null}
          {caps.download ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={t("row.download")}
              aria-label={t("row.download")}
              onClick={() => onDownload(file.id, file.name)}
            >
              <DownloadIcon className="size-4" />
            </Button>
          ) : null}
          {onKeep && caps.keep && file.expiresAt ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-8"
              title={t("row.keep")}
              aria-label={t("row.keep")}
              onClick={() => onKeep(file)}
            >
              <PinIcon className="size-4" />
            </Button>
          ) : null}
          {onDelete && caps.delete ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive size-8"
              title={t("row.delete")}
              aria-label={t("row.delete")}
              onClick={() => onDelete(file)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
