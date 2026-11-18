// SPDX-License-Identifier: Apache-2.0

/**
 * The type and pixel size of an image, read from its header alone.
 *
 * One reader for every consumer that must know what an image declares before anything decodes it
 * (an uploaded icon's bounds, a chat attachment's decompression-bomb guard). Only the header is
 * walked, never the pixels; any header that is truncated or malformed answers `null`.
 */

export type ImageSizeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageSize {
  type: ImageSizeType;
  width: number;
  height: number;
}

type Size = { width: number; height: number };

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...b.subarray(at, at + length));

/** The 8-byte signature every PNG file starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG declares its size in the `IHDR` chunk, which the format requires first: after the
 * signature, its length (13), `IHDR`, then width and height as big-endian 32-bit integers.
 */
function png(b: Uint8Array): Size | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return null;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Frames of a GIF whose descriptor is read: a longer animation is judged on these. */
const GIF_MAX_FRAMES = 64;

/**
 * A GIF declares its size twice: the logical screen in the header, and each frame in its own image
 * descriptor, which may exceed the screen. A decoder allocates for the frames, so the answer is the
 * largest of the screen and of the first frames, walked block by block.
 */
function gif(b: Uint8Array): Size | null {
  if (b.length < 13 || ascii(b, 0, 3) !== "GIF") return null;
  let largest: Size = { width: u16le(b, 6), height: u16le(b, 8) };
  const consider = (width: number, height: number) => {
    if (width * height > largest.width * largest.height) largest = { width, height };
  };
  // Global colour table, when the packed flags say there is one.
  let at = 13 + ((b[10]! & 0x80) !== 0 ? 3 * 2 ** ((b[10]! & 7) + 1) : 0);
  const skipSubBlocks = (from: number): number => {
    let position = from;
    while (position < b.length && b[position] !== 0) position += 1 + b[position]!;
    return position + 1;
  };
  for (let frames = 0; at < b.length && frames < GIF_MAX_FRAMES;) {
    const block = b[at]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      at = skipSubBlocks(at + 2);
    } else if (block === 0x2c) {
      if (at + 10 > b.length) break;
      consider(u16le(b, at + 5), u16le(b, at + 7));
      frames += 1;
      const flags = b[at + 9]!;
      at += 10 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      // LZW minimum code size, then the data sub-blocks.
      at = skipSubBlocks(at + 1);
    } else {
      break;
    }
  }
  return largest;
}

/** Start-of-frame markers, which carry the size: SOF0 to SOF15 but DHT (C4), JPG (C8) and DAC (CC). */
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** A JPEG declares its size in the first start-of-frame segment, found by skipping the segments before it. */
function jpeg(b: Uint8Array): Size | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return at + 9 <= b.length ? { height: u16be(b, at + 5), width: u16be(b, at + 7) } : null;
    }
    // The scan data starts at SOS: no frame header after it.
    if (marker === 0xda) return null;
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

/** The canvas of a WebP, read from the first chunk (`VP8X`, `VP8L` or `VP8 `) of the RIFF container. */
function webp(b: Uint8Array): Size | null {
  if (b.length < 20 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  switch (ascii(b, 12, 4)) {
    case "VP8X":
      return b.length >= 30 ? { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 } : null;
    case "VP8L": {
      // Signature byte 0x2f, then width-1 and height-1 on 14 bits each.
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = u32le(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8 ":
      // Frame tag, the 9d 01 2a start code, then width and height on 14 bits (the rest is scale).
      if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    default:
      return null;
  }
}

/** The type and size an image declares in its header, `null` for any other bytes or an unreadable header. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  try {
    const readers: [ImageSizeType, (b: Uint8Array) => Size | null][] = [
      ["image/png", png],
      ["image/jpeg", jpeg],
      ["image/gif", gif],
      ["image/webp", webp],
    ];
    for (const [type, read] of readers) {
      const size = read(bytes);
      if (size) return { type, ...size };
    }
    return null;
  } catch {
    return null;
  }
}
