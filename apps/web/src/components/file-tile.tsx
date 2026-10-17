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
import { useFileExcerpt, useFileImageSrc, type FileDto } from "../hooks/use-files";
import { useInView } from "../hooks/use-in-view";
import { formatBytes } from "../lib/format-bytes";
import { formatDateField } from "../lib/format-date";
import { DocumentRowActions } from "./document-row-actions";
import { ExpiryBadge, MimeIcon } from "./file-badges";

function MimePlaceholder({ mime }: { mime: string }) {
  return (
    <div className="flex size-full items-center justify-center">
      <MimeIcon mime={mime} className="text-muted-foreground size-10" />
    </div>
  );
}

// Mount the authenticated read only for images the caller can download.
function FileTileImage({ file, inView }: { file: FileDto; inView: boolean }) {
  const src = useFileImageSrc(file.id, inView);
  if (src === undefined) return <Skeleton className="size-full rounded-none" />;
  if (!src) return <MimePlaceholder mime={file.mime} />;
  return <img src={src} alt="" className="size-full object-cover" />;
}

// Plain text only (a React text node, never HTML or rendered Markdown). The server decides which
// types have one (null for the rest, storage untouched); the icon stays until an excerpt arrives.
function FileTileExcerpt({ file, inView }: { file: FileDto; inView: boolean }) {
  const { data: excerpt } = useFileExcerpt(file.id, inView);
  if (!excerpt) return <MimePlaceholder mime={file.mime} />;
  return (
    <div className="relative size-full overflow-hidden p-3 text-left">
      <p className="text-muted-foreground text-xs break-words whitespace-pre-line">{excerpt}</p>
      <div className="from-muted pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t to-transparent" />
    </div>
  );
}

export function FileTile({
  file,
  isKeepPending,
  onDownload,
  onDelete,
  onKeep,
  onPreview,
  showRunLink,
}: {
  file: FileDto;
  isKeepPending: boolean;
  onDownload: (file: FileDto) => void;
  onDelete: (file: FileDto) => void;
  onKeep: (file: FileDto) => void;
  onPreview: (file: FileDto) => void;
  showRunLink?: boolean;
}) {
  const { t } = useTranslation(["files", "common"]);
  const { preview, download } = file.capabilities;
  const activate = preview ? onPreview : download ? onDownload : undefined;
  const [ref, inView] = useInView<HTMLDivElement>();
  const media =
    download && isImageMime(file.mime) ? (
      <FileTileImage file={file} inView={inView} />
    ) : download ? (
      <FileTileExcerpt file={file} inView={inView} />
    ) : (
      <MimePlaceholder mime={file.mime} />
    );

  return (
    <Card ref={ref} className="flex flex-col overflow-hidden">
      <CardContent className="p-0">
        {activate ? (
          <button
            type="button"
            onClick={() => activate(file)}
            aria-label={`${preview ? t("row.preview") : t("common:btn.download")}: ${file.name}`}
            className="bg-muted hover:bg-muted/70 focus-visible:ring-ring relative block aspect-square w-full outline-none focus-visible:ring-2 focus-visible:ring-inset"
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
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
