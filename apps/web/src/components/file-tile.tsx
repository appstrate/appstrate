// SPDX-License-Identifier: Apache-2.0

/**
 * Presentational grid tile for a single file — shared by the run-detail
 * Files tab and the gallery page. Renders a square media area (an image
 * preview when the file is an image, the mime icon otherwise), the name,
 * size + created time, and the file's « … » menu (`DocumentRowActions`, the
 * same actions as the table). Behavior (download, delete, keep) is
 * injected by the parent; the only fetching this component does is the
 * authenticated image preview, isolated in `FileTileImage` so the hook runs
 * only for eligible images.
 */

import { useTranslation } from "react-i18next";
import { FileInput, FileOutput } from "lucide-react";
import { formatBytes } from "../lib/format-bytes";
import { formatDateField } from "../lib/format-date";
import type { RunFileDirection } from "../lib/files";
import { isImageMime } from "@appstrate/core/mime";
import { useFileImageSrc, type FileDto } from "../hooks/use-files";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { DocumentRowActions } from "./document-row-actions";
import { ExpiryBadge, MimeIcon } from "./file-badges";

/** Centered mime-icon placeholder — the non-image media, and the image fallback. */
function MimePlaceholder({ mime }: { mime: string }) {
  return (
    <div className="flex size-full items-center justify-center">
      <MimeIcon mime={mime} className="text-muted-foreground size-10" />
    </div>
  );
}

/**
 * Image branch: the authenticated cover-cropped preview, a placeholder block in
 * its place while the fetch is in flight, the mime placeholder when there is
 * none. Kept as its own component so the fetch hook only runs for eligible
 * images (hooks can't be called conditionally).
 */
function FileTileImage({ file }: { file: FileDto }) {
  const src = useFileImageSrc(file.id);
  if (src === undefined) return <Skeleton className="size-full rounded-none" />;
  if (!src) return <MimePlaceholder mime={file.mime} />;
  return <img src={src} alt={file.name} className="size-full object-cover" />;
}

export function FileTile({
  file,
  isKeepPending,
  onDownload,
  onDelete,
  onKeep,
  onPreview,
  showRunLink,
  direction,
}: {
  file: FileDto;
  isKeepPending: boolean;
  onDownload: (file: FileDto) => void;
  onDelete: (file: FileDto) => void;
  onKeep: (file: FileDto) => void;
  onPreview: (file: FileDto) => void;
  /** Show the producing-agent label + a link to its run (gallery). */
  showRunLink?: boolean;
  /** Run tab only: whether this run consumed the file (input) or produced it (output). */
  direction?: RunFileDirection;
}) {
  const { t } = useTranslation("files");
  // Every affordance is driven by the server-computed capabilities (the single
  // source), not client-side guessing.
  const caps = file.capabilities;

  const canPreview = caps.preview;
  // Media click mirrors the primary action: preview when available, else the
  // authenticated download when the content is reachable.
  const activate = canPreview
    ? () => onPreview(file)
    : caps.download
      ? () => onDownload(file)
      : undefined;
  const activateLabel = canPreview ? t("row.preview") : t("common:btn.download");

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
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={file.name}>
            {file.name}
          </span>
          <DocumentRowActions
            doc={file}
            isPending={isKeepPending}
            showRunLink={showRunLink}
            onPreview={onPreview}
            onDownload={onDownload}
            onKeep={onKeep}
            onDelete={onDelete}
          />
        </div>
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
      </div>
    </div>
  );
}
