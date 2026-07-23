// SPDX-License-Identifier: Apache-2.0

/**
 * THE unified renderer for a chat-surfaced document attachment — shared by the
 * sent user-message attachments (`thread.tsx`, input) and the run-card output
 * documents (`chat-run-progress-card.tsx`, output). An image renders as a small
 * square thumbnail (authenticated fetch → object URL); anything else renders as
 * a clickable chip. The click action (in-app preview vs. authenticated download)
 * and its label come from `documentActivation`, so both surfaces behave
 * identically.
 */

import * as React from "react";
import { DownloadIcon, EyeIcon } from "lucide-react";
import { documentActivation } from "./doc-activation.ts";
import { documentContentHref } from "./run-events.ts";
import type { GetHeaders, OpenDocument } from "./runtime-context.ts";

/** True for an `image/*` mime — the only content shown as a thumbnail. */
export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime?.startsWith("image/");
}

/** Base chip look, shared with the inert composer/attachment chips in the thread. */
export const ATTACHMENT_CHIP_CLASS =
  "bg-background text-foreground inline-flex max-w-52 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs";

/**
 * Square thumbnail style — the single standard for ALL chat image previews (sent
 * attachments, staged uploads, run-card documents): a 64px cover-cropped square.
 */
export const ATTACHMENT_IMAGE_CLASS = "size-16 shrink-0 rounded-lg border object-cover";

/**
 * Authenticated fetch of a stored document's content route → object URL for an
 * <img> src, revoked on unmount / id change. Returns null while loading or on
 * failure (callers fall back to the chip). The content route only serves stored
 * documents, so this is only ever used for a resolved `document://`.
 */
export function useDocumentImageSrc(id: string, getHeaders: GetHeaders | null): string | null {
  const [src, setSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(documentContentHref(id), {
          headers: getHeaders?.() ?? {},
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        // Fetch failure → stay on the chip fallback (src stays null).
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, getHeaders]);
  return src;
}

/**
 * Clickable chip: the action glyph (eye when an in-app preview opener is
 * present, download arrow otherwise — mirroring `documentActivation`'s label) +
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
  opener: OpenDocument | null;
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
      <span className="truncate font-medium">{name || "document"}</span>
    </button>
  );
}

/**
 * Image branch: the authenticated thumbnail, falling back to the chip while the
 * fetch is in flight or on failure (src null). Kept as its own component so the
 * fetch hook only runs for images (hooks can't be called conditionally).
 */
function DocumentImageThumbnail({
  id,
  name,
  label,
  opener,
  getHeaders,
  onActivate,
}: {
  id: string;
  name: string;
  label: string;
  opener: OpenDocument | null;
  getHeaders: GetHeaders | null;
  onActivate: () => void;
}) {
  const src = useDocumentImageSrc(id, getHeaders);
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
 * The unified document attachment. An image renders as a clickable square
 * thumbnail; anything else renders as the clickable chip. Both open the same
 * activation (in-app preview when a host opener is present, else the
 * authenticated download).
 */
export function DocumentAttachment({
  doc,
  opener,
  getHeaders,
}: {
  doc: { id: string; name: string; mime?: string | null };
  opener: OpenDocument | null;
  getHeaders: GetHeaders | null;
}) {
  const { onActivate, label } = documentActivation(doc, opener, getHeaders);
  if (isImageMime(doc.mime)) {
    return (
      <DocumentImageThumbnail
        id={doc.id}
        name={doc.name}
        label={label}
        opener={opener}
        getHeaders={getHeaders}
        onActivate={onActivate}
      />
    );
  }
  return <AttachmentChip name={doc.name} label={label} opener={opener} onActivate={onActivate} />;
}
