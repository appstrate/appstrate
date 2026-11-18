// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { imageDimensions, isDecodable } from "../src/pi-chat/image-dimensions.ts";
import { resizeWithPi } from "../src/pi-chat/attachment-images.ts";

const PIXEL_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Only the header a size is read from: the pixels are never needed, which is the point. */
const pngHeader = (width: number, height: number) =>
  new Uint8Array([
    0x89,
    ...ascii("PNG"),
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ]);

const jpegHeader = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);

const gifHeader = (width: number, height: number) =>
  new Uint8Array([...ascii("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0]);

const riff = (chunk: string, payload: number[]) =>
  new Uint8Array([
    ...ascii("RIFF"),
    0,
    0,
    0,
    0,
    ...ascii("WEBP"),
    ...ascii(chunk),
    0,
    0,
    0,
    0,
    ...payload,
  ]);

describe("imageDimensions", () => {
  it("reads PNG, JPEG (past other segments) and GIF", () => {
    expect(imageDimensions(PIXEL_PNG)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageDimensions(jpegHeader(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 });
  });

  it("reads the three WebP layouts", () => {
    // VP8X: canvas width-1 / height-1 on 24 bits, little endian.
    const vp8x = riff("VP8X", [0, 0, 0, 0, 99, 0, 0, 49, 0, 0]);
    expect(imageDimensions(vp8x)).toEqual({ width: 100, height: 50 });
    // VP8L: payload starts with 0x2f, then 14 + 14 bits of width-1 / height-1.
    const bits = (639 | (479 << 14)) >>> 0;
    const vp8l = riff("VP8L", [
      0x2f,
      bits & 255,
      (bits >>> 8) & 255,
      (bits >>> 16) & 255,
      (bits >>> 24) & 255,
    ]);
    expect(imageDimensions(vp8l)).toEqual({ width: 640, height: 480 });
    // VP8: 3 bytes of frame tag, the start code, then 14 bit width and height.
    const vp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600)]);
    expect(imageDimensions(vp8)).toEqual({ width: 800, height: 600 });
  });

  it("answers null for bytes that are no image, or a truncated header", () => {
    expect(imageDimensions(new TextEncoder().encode("not an image at all, just text"))).toBeNull();
    expect(imageDimensions(pngHeader(10, 10).subarray(0, 20))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe("a GIF's frames", () => {
  /** Screen header, then one frame whose own descriptor declares `frame` (and no colour table, one empty LZW block). */
  const withFrame = (screen: [number, number], frame: [number, number]) =>
    new Uint8Array([
      ...ascii("GIF89a"),
      ...le16(screen[0]),
      ...le16(screen[1]),
      0,
      0,
      0,
      // A graphic control extension, to be skipped.
      0x21,
      0xf9,
      4,
      0,
      0,
      0,
      0,
      0,
      // Image descriptor: separator, left, top, width, height, flags.
      0x2c,
      0,
      0,
      0,
      0,
      ...le16(frame[0]),
      ...le16(frame[1]),
      0,
      // LZW minimum code size, one empty sub-block terminator.
      2,
      0,
      0x3b,
    ]);

  it("answers the largest of the logical screen and the frames", () => {
    expect(imageDimensions(withFrame([10, 10], [30, 5]))).toEqual({ width: 30, height: 5 });
    expect(imageDimensions(withFrame([10, 10], [8, 8]))).toEqual({ width: 10, height: 10 });
  });

  it("refuses a GIF whose frame exceeds the cap though its screen is tiny", () => {
    expect(isDecodable(withFrame([1, 1], [30_000, 30_000]))).toBe(false);
    expect(isDecodable(withFrame([10, 10], [10, 10]))).toBe(true);
  });
});

describe("isDecodable", () => {
  it("accepts an ordinary photo and refuses one over 40 megapixels or one it cannot read", () => {
    expect(isDecodable(jpegHeader(6000, 4000))).toBe(true);
    expect(isDecodable(pngHeader(30_000, 30_000))).toBe(false);
    expect(isDecodable(jpegHeader(8000, 6000))).toBe(false);
    expect(isDecodable(pngHeader(0, 0))).toBe(false);
    expect(isDecodable(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("resizeWithPi", () => {
  it("refuses a decompression-bomb image before Pi decodes it", async () => {
    // A header alone: if the guard were missing, Photon would be asked to decode garbage.
    expect(await resizeWithPi(pngHeader(30_000, 30_000), "image/png")).toBeNull();
  });

  it("resizes a real image through Pi", async () => {
    const resized = await resizeWithPi(PIXEL_PNG, "image/png");
    expect(resized?.mimeType).toBe("image/png");
    expect(Buffer.from(resized!.data, "base64").length).toBeGreaterThan(0);
  });
});
