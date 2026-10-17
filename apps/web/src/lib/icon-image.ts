// SPDX-License-Identifier: Apache-2.0

import { IMAGE_ICON_PREFIX, isIconImage } from "@appstrate/core/appearance";

/** Largest image file accepted for an icon, before it is cropped and re-encoded. */
export const ICON_SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/** Image types the encoder reads: what `createImageBitmap` decodes in every browser. */
export const ICON_SOURCE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Edge lengths tried in turn; the first encoding that `isIconImage` accepts wins. */
const ICON_SIZES = [128, 96];

/** Why an icon image could not be produced; one `appearance.error.<code>` sentence each. */
export type IconImageError = "icon_file_type" | "icon_file_size" | "icon_processing";

/** The rejection of `encodeIconImage`, naming its `IconImageError`. */
export class IconImageFailure extends Error {
  constructor(readonly code: IconImageError) {
    super(code);
    this.name = "IconImageFailure";
  }
}

/** What refuses `file` before it is decoded, or `null`. */
export function iconSourceError(file: { type: string; size: number }): IconImageError | null {
  if (!file.type.startsWith("image/")) return "icon_file_type";
  if (file.size > ICON_SOURCE_MAX_BYTES) return "icon_file_size";
  return null;
}

/** The largest centred square of a `width` × `height` image. */
export function centerSquare(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/** WebP bytes as the icon data URI `isIconImage` reads. */
export function iconDataUri(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return IMAGE_ICON_PREFIX + btoa(binary);
}

function encodeWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new IconImageFailure("icon_processing"))),
      "image/webp",
      0.82,
    ),
  );
}

/**
 * An image file as an uploaded icon: centre-cropped to a square and re-encoded
 * to WebP, at 128 then 96 px, keeping the first result `isIconImage` accepts.
 * Rejects with an `IconImageFailure`. A browser that cannot encode WebP hands
 * back another format, which `isIconImage` refuses.
 */
export async function encodeIconImage(file: File): Promise<string> {
  const refused = iconSourceError(file);
  if (refused) throw new IconImageFailure(refused);

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new IconImageFailure("icon_processing");
  });
  try {
    const crop = centerSquare(bitmap.width, bitmap.height);
    for (const size of ICON_SIZES) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new IconImageFailure("icon_processing");
      context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
      const blob = await encodeWebp(canvas);
      const uri = iconDataUri(new Uint8Array(await blob.arrayBuffer()));
      if (isIconImage(uri)) return uri;
    }
  } finally {
    bitmap.close();
  }
  throw new IconImageFailure("icon_processing");
}

/** The `IconImageError` an `encodeIconImage` rejection carries; `icon_processing` for anything else. */
export function iconImageErrorCode(error: unknown): IconImageError {
  return error instanceof IconImageFailure ? error.code : "icon_processing";
}
