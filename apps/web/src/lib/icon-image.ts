// SPDX-License-Identifier: Apache-2.0

import { ICON_IMAGE_TYPES, isIconImage } from "@appstrate/core/appearance";

/** Largest image file accepted for an icon, before it is cropped and re-encoded. */
export const ICON_SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Image types the encoder reads: what `createImageBitmap` decodes in every
 * browser. SVG stays out — a vector file has no pixel size to crop, and not
 * every browser rasterises one through `createImageBitmap`.
 */
const ICON_SOURCE_TYPE_LIST = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** The file input's `accept`. */
export const ICON_SOURCE_TYPES = ICON_SOURCE_TYPE_LIST.join(",");

/**
 * Edge lengths tried in turn; the first encoding that `isIconImage` accepts
 * wins. The ladder goes down to 32 px for WebKit, which encodes no WebP: a
 * photographic PNG is still 7–13 KB at 64 px.
 */
const ICON_SIZES = [128, 96, 64, 48, 32] as const;

type IconImageType = (typeof ICON_IMAGE_TYPES)[number];

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
  if (!(ICON_SOURCE_TYPE_LIST as readonly string[]).includes(file.type)) return "icon_file_type";
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

/** Encoded image bytes as a base64 data URI of their `type`. */
export function iconDataUri(type: string, bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${type};base64,${btoa(binary)}`;
}

function isIconImageType(type: string): type is IconImageType {
  return (ICON_IMAGE_TYPES as readonly string[]).includes(type);
}

/** Draws the square at `size` px and encodes it as WebP; `null` when the browser cannot. */
export type IconEncoder = (size: number) => Promise<Blob | null>;

/**
 * The first encoding `isIconImage` accepts, walking the size ladder. Each size
 * asks for WebP once; a browser that cannot encode WebP (WebKit) hands back a
 * PNG, as the HTML spec's `toBlob` fallback requires, and that PNG is kept. The
 * data URI names the type the blob actually carries.
 */
export async function pickIconEncoding(encode: IconEncoder): Promise<string> {
  for (const size of ICON_SIZES) {
    const blob = await encode(size);
    if (!blob || !isIconImageType(blob.type)) continue;
    const uri = iconDataUri(blob.type, new Uint8Array(await blob.arrayBuffer()));
    if (isIconImage(uri)) return uri;
  }
  throw new IconImageFailure("icon_processing");
}

function canvasEncoder(bitmap: ImageBitmap): IconEncoder {
  const crop = centerSquare(bitmap.width, bitmap.height);
  return (size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return Promise.resolve(null);
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  };
}

/**
 * An image file as an uploaded icon: centre-cropped to a square and re-encoded
 * as WebP, or PNG where the browser encodes no WebP (`pickIconEncoding`).
 * Rejects with an `IconImageFailure`.
 */
export async function encodeIconImage(file: File): Promise<string> {
  const refused = iconSourceError(file);
  if (refused) throw new IconImageFailure(refused);

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new IconImageFailure("icon_processing");
  });
  try {
    return await pickIconEncoding(canvasEncoder(bitmap));
  } finally {
    bitmap.close();
  }
}

/** The `IconImageError` an `encodeIconImage` rejection carries; `icon_processing` for anything else. */
export function iconImageErrorCode(error: unknown): IconImageError {
  return error instanceof IconImageFailure ? error.code : "icon_processing";
}
