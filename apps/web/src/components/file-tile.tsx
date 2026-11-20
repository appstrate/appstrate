// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@appstrate/ui/components/card";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { isImageMime } from "@appstrate/core/mime";
import { useFileImageSrc, type FileDto } from "../hooks/use-files";
import { formatBytes } from "../lib/format-bytes";
import { formatDateField } from "../lib/format-date";
import { DocumentRowActions } from "./document-row-actions";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { ExpiryBadge } from "./file-badges";
import { SkeletonLine } from "./skeleton-line";
import { SpaceNameOf } from "./space-name";

function MimePlaceholder({ file }: { file: FileDto }) {
  return (
    <div className="flex size-full items-center justify-center">
      <MimeIcon mime={file.mime} name={file.name} className="text-muted-foreground size-10" />
    </div>
  );
}

// Mount the authenticated read only for images the caller can download.
function FileTileImage({ file }: { file: FileDto }) {
  const src = useFileImageSrc(file.id, file.spaceId);
  if (src === undefined) return <Skeleton className="size-full rounded-none" />;
  if (!src) return <MimePlaceholder file={file} />;
  return <img src={src} alt="" className="size-full object-cover" />;
}

export function FileTile({
  file,
  isKeepPending,
  onDownload,
  onDelete,
  onKeep,
  onPreview,
  showRunLink,
  showSpace = false,
}: {
  file: FileDto;
  isKeepPending: boolean;
  onDownload: (file: FileDto) => void;
  onDelete: (file: FileDto) => void;
  onKeep: (file: FileDto) => void;
  onPreview: (file: FileDto) => void;
  showRunLink?: boolean;
  /** Name the space it lives in: a list spanning spaces. */
  showSpace?: boolean;
}) {
  const { t } = useTranslation(["files", "common"]);
  const { preview, download } = file.capabilities;
  const activate = preview ? onPreview : download ? onDownload : undefined;
  const media =
    download && isImageMime(file.mime) ? (
      <FileTileImage file={file} />
    ) : (
      <MimePlaceholder file={file} />
    );

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardContent className="p-0">
        {activate ? (
          <button
            type="button"
            onClick={() => activate(file)}
            aria-label={`${preview ? t("row.preview") : t("common:btn.download")}: ${file.name}`}
            className="bg-muted/40 hover:bg-muted/50 focus-visible:ring-ring relative block aspect-square w-full outline-none focus-visible:ring-2 focus-visible:ring-inset"
          >
            {media}
          </button>
        ) : (
          <div className="bg-muted aspect-square w-full">{media}</div>
        )}
      </CardContent>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-1">
          <CardTitle className="min-w-0 flex-1 truncate" title={file.name}>
            {file.name}
          </CardTitle>
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
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="tabular-nums">{formatBytes(file.size)}</span>
          <span aria-hidden>·</span>
          <span>{formatDateField(file.createdAt, "datetime")}</span>
          <ExpiryBadge expiresAt={file.expiresAt} />
          {showSpace && (
            <>
              <span aria-hidden>·</span>
              <SpaceNameOf spaceId={file.spaceId} />
            </>
          )}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

/**
 * `FileTile` while the files load: the square preview, then the header — a title
 * row as tall as its `size-7` actions button, then the size and date line.
 */
export function FileTileSkeleton() {
  return (
    <Card className="flex flex-col overflow-hidden">
      <CardContent className="p-0">
        <Skeleton className="aspect-square w-full rounded-none" />
      </CardContent>
      <CardHeader>
        <div className="flex min-h-7 min-w-0 items-center gap-1">
          <SkeletonLine className="w-3/4 text-sm leading-none font-semibold" />
        </div>
        <SkeletonLine className="w-2/3 text-sm" />
      </CardHeader>
    </Card>
  );
}
