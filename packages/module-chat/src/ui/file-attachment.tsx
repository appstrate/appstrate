// SPDX-License-Identifier: Apache-2.0

/**
 * THE unified renderer for a chat-surfaced file attachment — shared by the
 * sent user-message attachments (`thread.tsx`, input) and the run-card output
 * files (`chat-run-progress-card.tsx`, output). An image renders as a small
 * square thumbnail; anything else renders as the attachment chip. The click
 * action (in-app preview vs. authenticated download) and its label come from
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
import { Skeleton } from "@appstrate/ui/components/skeleton";

/** The chip: one 32px height (the toolbar's) whatever it carries — sent file, staged upload. */
const ATTACHMENT_CHIP_CLASS =
  "bg-background text-foreground inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg border pr-2 pl-1 text-xs";

/** The chip's leading square: an image's thumbnail or the file type's icon. */
const CHIP_MEDIA_CLASS = "size-6 shrink-0 rounded-md";

/**
 * Square thumbnail style — the single standard for chat image previews of a
 * message (sent attachments, run-card files): a 64px cover-cropped square. A
 * staged upload shows its image inside the chip instead.
 */
export const ATTACHMENT_IMAGE_CLASS = "size-16 shrink-0 rounded-lg border object-cover";

/**
 * THE attachment chip (shadcn AI Elements « inline attachment » anatomy): a
 * leading media square (`media`, else the mime's icon), the truncated name,
 * then `trailing` (a staged upload's size and remove button). With `action`,
 * the media and name are the button that opens the file; `trailing` stays
 * outside it. `stopPropagation` keeps a click from also firing an enclosing
 * card's full-surface click target (the run-progress card).
 */
export function AttachmentChip({
  name,
  mime,
  media,
  title,
  action,
  trailing,
}: {
  name: string;
  mime?: string | null;
  media?: ReactNode;
  title?: string;
  action?: { label: string; onActivate: () => void } | null;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      {media ?? (
        <span className={`${CHIP_MEDIA_CLASS} bg-muted flex items-center justify-center`}>
          <MimeIcon mime={mime ?? ""} className="text-muted-foreground size-3.5" />
        </span>
      )}
      <span className="text-foreground truncate text-xs font-medium">{name || UNNAMED_FILE}</span>
    </>
  );
  if (!action) {
    return (
      <div className={ATTACHMENT_CHIP_CLASS} title={title}>
        {content}
        {trailing}
      </div>
    );
  }
  const activate = (e: React.MouseEvent) => {
    e.stopPropagation();
    action.onActivate();
  };
  if (!trailing) {
    return (
      <button
        type="button"
        onClick={activate}
        title={action.label}
        aria-label={action.label}
        className={`${ATTACHMENT_CHIP_CLASS} hover:bg-muted/50`}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={ATTACHMENT_CHIP_CLASS}>
      <button
        type="button"
        onClick={activate}
        title={action.label}
        aria-label={action.label}
        className="text-foreground inline-flex min-w-0 items-center gap-1.5 text-xs hover:underline"
      >
        {content}
      </button>
      {trailing}
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
  return <img ref={attach} alt="" className={`${CHIP_MEDIA_CLASS} border object-cover`} />;
}

/**
 * A pending composer file: the chip, its media an image's own thumbnail (from
 * the picked File) or the mime's icon. `preview` (the host's panel on the
 * picked file) makes the media and name its button; `trailing` (size, remove
 * button) stays outside it.
 */
export function PendingAttachmentChip({
  name,
  file,
  preview,
  trailing,
}: {
  name: string;
  file: File | undefined;
  preview: { label: string; onActivate: () => void } | null;
  trailing: ReactNode;
}) {
  return (
    <AttachmentChip
      name={name}
      mime={file?.type}
      media={file && isImageMime(file.type) ? <LocalImageMedia file={file} /> : undefined}
      action={preview}
      trailing={trailing}
    />
  );
}

/**
 * Image branch: the host's authenticated thumbnail, falling back to the chip
 * while the fetch is in flight or on failure (src null). Kept as its own
 * component so the injected hook only runs for images (hooks can't be called
 * conditionally).
 */
function FileImageThumbnail({
  id,
  name,
  mime,
  spaceId,
  label,
  onActivate,
}: {
  id: string;
  name: string;
  mime: string;
  spaceId?: string;
  label: string;
  onActivate: () => void;
}) {
  // Destructured out of the host bag, then called at this component's top level
  // — a stable, unconditional hook call position.
  const { useFileImageSrc } = useChatHost();
  const src = useFileImageSrc(id, spaceId);
  // In flight: the thumbnail's box, so the message does not reflow when it lands.
  if (src === undefined) return <Skeleton className="size-16 shrink-0 rounded-lg" />;
  if (!src) return <AttachmentChip name={name} mime={mime} action={{ label, onActivate }} />;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      title={label}
      aria-label={label}
    >
      <img src={src} alt={name || "image"} className={ATTACHMENT_IMAGE_CLASS} />
    </button>
  );
}

/**
 * The unified file attachment. An image renders as a clickable square
 * thumbnail; anything else renders as the clickable chip, its glyph the file
 * type's icon. Both open the same
 * activation (in-app preview when a host opener is present, else the host's
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
  if (file.mime && isImageMime(file.mime)) {
    return (
      <FileImageThumbnail
        id={file.id}
        name={file.name}
        mime={file.mime}
        spaceId={file.spaceId}
        label={label}
        onActivate={onActivate}
      />
    );
  }
  return <AttachmentChip name={file.name} mime={file.mime} action={{ label, onActivate }} />;
}
