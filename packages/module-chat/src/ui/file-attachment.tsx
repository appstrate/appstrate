// SPDX-License-Identifier: Apache-2.0

/**
 * THE unified renderer for a chat-surfaced file attachment — shared by the
 * sent user-message attachments (`thread.tsx`, input) and the run-card output
 * files (`chat-run-progress-card.tsx`, output). An image renders as a small
 * square thumbnail; anything else renders as a clickable chip. The click action
 * (in-app preview vs. authenticated download) and its label come from
 * `fileActivation`, so both surfaces behave identically.
 *
 * Every service this needs — the preview opener, the authenticated download, the
 * authenticated image hook, the translator — is read from the host injection
 * seam, so callers pass a file and nothing else.
 */

import { DownloadIcon, EyeIcon } from "lucide-react";
import { fileActivation } from "./file-activation.ts";
import { useChatHost } from "./runtime-context.ts";
import type { OpenFile } from "./runtime-context.ts";

/** True for an `image/*` mime — the only content shown as a thumbnail. */
export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime?.startsWith("image/");
}

/** Base chip look, shared with the inert composer/attachment chips in the thread. */
export const ATTACHMENT_CHIP_CLASS =
  "bg-background text-foreground inline-flex max-w-52 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs";

/**
 * Square thumbnail style — the single standard for ALL chat image previews (sent
 * attachments, staged uploads, run-card files): a 64px cover-cropped square.
 */
export const ATTACHMENT_IMAGE_CLASS = "size-16 shrink-0 rounded-lg border object-cover";

/**
 * Clickable chip: the action glyph (eye when an in-app preview opener is
 * present, download arrow otherwise — mirroring `fileActivation`'s label) +
 * the truncated name. `stopPropagation` keeps a chip click from also firing an
 * enclosing card's full-surface click target (the run-progress card).
 */
function AttachmentChip({
  name,
  label,
  opener,
  onActivate,
}: {
  name: string;
  label: string;
  opener: OpenFile | null;
  onActivate: () => void;
}) {
  const Icon = opener ? EyeIcon : DownloadIcon;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      title={label}
      aria-label={label}
      className={`${ATTACHMENT_CHIP_CLASS} hover:bg-muted`}
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="truncate font-medium">{name || "file"}</span>
    </button>
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
  label,
  opener,
  onActivate,
}: {
  id: string;
  name: string;
  label: string;
  opener: OpenFile | null;
  onActivate: () => void;
}) {
  // Destructured out of the host bag, then called at this component's top level
  // — a stable, unconditional hook call position.
  const { useFileImageSrc } = useChatHost();
  const src = useFileImageSrc(id);
  if (!src)
    return <AttachmentChip name={name} label={label} opener={opener} onActivate={onActivate} />;
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
 * thumbnail; anything else renders as the clickable chip. Both open the same
 * activation (in-app preview when a host opener is present, else the host's
 * authenticated download).
 */
export function FileAttachment({
  file,
}: {
  file: { id: string; name: string; mime?: string | null };
}) {
  const { openFile: opener, downloadFile, t } = useChatHost();
  const { onActivate, label } = fileActivation(file, opener, downloadFile, t);
  if (isImageMime(file.mime)) {
    return (
      <FileImageThumbnail
        id={file.id}
        name={file.name}
        label={label}
        opener={opener}
        onActivate={onActivate}
      />
    );
  }
  return <AttachmentChip name={file.name} label={label} opener={opener} onActivate={onActivate} />;
}
