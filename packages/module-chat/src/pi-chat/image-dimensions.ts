// SPDX-License-Identifier: Apache-2.0

/**
 * The pixel size of an image, read from its header alone.
 *
 * Pi decodes an image (Photon, WebAssembly) before it can shrink it, and the stored size says
 * nothing about the decoded one: a 30 000 x 30 000 PNG of one flat colour weighs a few hundred
 * kilobytes and decodes to 3.6 GB of RGBA. The header is read first so such a file is refused
 * before anything allocates for it.
 */

/** Pixels above which an image is not decoded (about a 7000 x 5600 photo is 40 Mpx). */
const IMAGE_MAX_PIXELS = 40_000_000;

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...b.subarray(at, at + length));

type Size = { width: number; height: number };

function png(b: Uint8Array): Size | null {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return null;
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

function webp(b: Uint8Array): Size | null {
  if (b.length < 21 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** The size an image of one of the four formats a provider takes declares, `null` when unreadable. */
export function imageDimensions(bytes: Uint8Array): Size | null {
  try {
    return png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes);
  } catch {
    return null;
  }
}

/** Whether the image declares a size that is safe to decode. An unreadable header is not safe. */
export function isDecodable(bytes: Uint8Array): boolean {
  const size = imageDimensions(bytes);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width * size.height <= IMAGE_MAX_PIXELS
  );
}
