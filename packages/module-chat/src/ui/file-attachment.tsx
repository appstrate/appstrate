// SPDX-License-Identifier: Apache-2.0

/**
 * THE unified renderer for a chat-surfaced file attachment — shared by the
 * sent user-message attachments (`thread.tsx`, input) and the run-card output
 * files (`chat-run-progress-card.tsx`, output) — and by the composer's staged
 * uploads: every chat file is the one attachment chip, an image's thumbnail or
 * the file type's icon in its media square. The click action (in-app preview vs. authenticated download) and its label come from
 * `fileActivation`, so both surfaces behave identically.
 *
 * Every service this needs — the preview opener, the authenticated download, the
 * authenticated image hook, the translator — is read from the host injection
 * seam, so callers pass a file and nothing else.
 */

import * as React from "react";
import type { ReactNode } from "react";
import { isImageMime } from "@appstrate/core/mime";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { fileActivation } from "./file-activation.ts";
import { UNNAMED_FILE } from "./run-events.ts";
import { useCanIn, useChatHost } from "./runtime-context.ts";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";

/** The chip: one 32px height (the toolbar's) whatever it carries — sent, produced or staged file. */
const ATTACHMENT_CHIP_CLASS =
  "bg-background text-foreground inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg border pr-2 pl-1 text-xs";

/** The chip's leading square: an image's thumbnail or the file type's icon. */
const CHIP_MEDIA_CLASS = "size-6 shrink-0 rounded-md";

/** The media square holding an image's own pixels, cover-cropped. */
const CHIP_THUMBNAIL_CLASS = `${CHIP_MEDIA_CLASS} border object-cover`;

/** The file type's icon in the media square — every non-image, and an image without a thumbnail. */
function MimeMedia({ mime, name }: { mime?: string | null; name?: string }) {
  return (
    <span className={`${CHIP_MEDIA_CLASS} bg-muted flex items-center justify-center`}>
      <MimeIcon mime={mime ?? ""} name={name} className="text-muted-foreground size-3.5" />
    </span>
  );
}

/** An image's thumbnail in the media square, from a URL the caller holds (staged upload). */
export function AttachmentThumbnail({ src }: { src: string }) {
  return <img src={src} alt="" className={CHIP_THUMBNAIL_CLASS} />;
}

/** The file action owns the icon, name and size. A staged file's remove button is its sibling. */
export function AttachmentChip({
  name,
  mime,
  media,
  title,
  action,
  sizeLabel,
  remove,
}: {
  name: string;
  mime?: string | null;
  media?: ReactNode;
  title?: string;
  action?: { label: string; onActivate: () => void } | null;
  sizeLabel?: string;
  remove?: ReactNode;
}) {
  const content = (
    <>
      {media ?? <MimeMedia mime={mime} name={name} />}
      <span className="text-foreground truncate text-xs font-medium">{name || UNNAMED_FILE}</span>
      {sizeLabel && <span className="text-muted-foreground shrink-0">{sizeLabel}</span>}
    </>
  );
  const bodyClass = remove
    ? "inline-flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-l-lg px-1 text-xs"
    : ATTACHMENT_CHIP_CLASS;
  const body = action ? (
    <button
      type="button"
      title={action.label}
      aria-label={action.label}
      onClick={(event) => {
        // Run cards have their own click action.
        event.stopPropagation();
        action.onActivate();
      }}
      className={cn(bodyClass, "hover:bg-muted/50 cursor-pointer")}
    >
      {content}
    </button>
  ) : (
    <div className={bodyClass} title={title}>
      {content}
    </div>
  );
  if (!remove) return body;
  return (
    <div className={cn(ATTACHMENT_CHIP_CLASS, "desktop-pointer:h-8 h-10 gap-0 px-0")}>
      {body}
      {remove}
    </div>
  );
}

/**
 * A staged image's thumbnail, in the chip's media square. The object URL lives
 * exactly as long as the element (React 19 ref cleanup), with no state
 * round-trip. Not the staged cache of `upload.ts`: that one is filled at send
 * time, after the chip is gone.
 */
function LocalImageMedia({ file }: { file: File }) {
  const attach = React.useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      const url = URL.createObjectURL(file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return <img ref={attach} alt="" className={CHIP_THUMBNAIL_CLASS} />;
}

/**
 * A pending composer file: the chip, its media an image's own thumbnail (from
 * the picked File) or the mime's icon. `preview` (the host's panel on the
 * picked file) makes the media, name and size its button.
 */
export function PendingAttachmentChip({
  name,
  file,
  preview,
  sizeLabel,
  remove,
}: {
  name: string;
  file: File | undefined;
  preview: { label: string; onActivate: () => void } | null;
  sizeLabel?: string;
  remove: ReactNode;
}) {
  return (
    <AttachmentChip
      name={name}
      mime={file?.type}
      media={file && isImageMime(file.type) ? <LocalImageMedia file={file} /> : undefined}
      action={preview}
      sizeLabel={sizeLabel}
      remove={remove}
    />
  );
}

/**
 * A stored image's thumbnail in the media square: the host's authenticated
 * preview, a skeleton of the square while it loads, the type's icon when there
 * is none. Its own component so the injected hook only runs for images (hooks
 * can't be called conditionally).
 */
function StoredImageMedia({ id, mime, spaceId }: { id: string; mime: string; spaceId?: string }) {
  // Destructured out of the host bag, then called at this component's top level
  // — a stable, unconditional hook call position.
  const { useFileImageSrc } = useChatHost();
  const src = useFileImageSrc(id, spaceId);
  if (src === undefined) return <Skeleton className={CHIP_MEDIA_CLASS} />;
  if (!src) return <MimeMedia mime={mime} />;
  return <AttachmentThumbnail src={src} />;
}

/**
 * The unified file attachment: the chip, an image's thumbnail (read in the
 * file's space) or the type's icon leading. It opens the file's activation
 * (in-app preview when a host opener is present, else the host's
 * authenticated download).
 */
export function FileAttachment({
  file,
}: {
  /** `spaceId`: the file's space when known (the space of the call that produced it). */
  file: { id: string; name: string; mime?: string | null; spaceId?: string };
}) {
  const { openFile: opener, downloadFile, t, useSpaceLabelOf } = useChatHost();
  const canIn = useCanIn();
  const spaceName = useSpaceLabelOf()(file.spaceId);
  // Preview, download and thumbnail all read the file's content (`files:read`), in its space.
  if (!canIn(file.spaceId, "files:read")) {
    const title = spaceName ? t("file.noAccessIn", { name: spaceName }) : t("file.noAccess");
    return <AttachmentChip name={file.name} mime={file.mime} title={title} />;
  }
  const { onActivate, label } = fileActivation(file, opener, downloadFile, t);
  return (
    <AttachmentChip
      name={file.name}
      mime={file.mime}
      media={
        file.mime && isImageMime(file.mime) ? (
          <StoredImageMedia id={file.id} mime={file.mime} spaceId={file.spaceId} />
        ) : undefined
      }
      action={{ label, onActivate }}
    />
  );
}
