// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isDecodable, resizeWithPi } from "../src/pi-chat/attachment-images.ts";

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

/** Screen header, then one frame whose own descriptor declares `frame` (no colour table, one empty LZW block). */
const gifWithFrame = (screen: [number, number], frame: [number, number]) =>
  new Uint8Array([
    ...ascii("GIF89a"),
    ...le16(screen[0]),
    ...le16(screen[1]),
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    ...le16(frame[0]),
    ...le16(frame[1]),
    0,
    2,
    0,
    0x3b,
  ]);

describe("isDecodable", () => {
  it("accepts an ordinary photo and refuses one over 40 megapixels or one it cannot read", () => {
    expect(isDecodable(jpegHeader(6000, 4000))).toBe(true);
    expect(isDecodable(pngHeader(30_000, 30_000))).toBe(false);
    expect(isDecodable(jpegHeader(8000, 6000))).toBe(false);
    expect(isDecodable(pngHeader(0, 0))).toBe(false);
    expect(isDecodable(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("refuses a GIF whose frame exceeds the cap though its screen is tiny", () => {
    expect(isDecodable(gifWithFrame([1, 1], [30_000, 30_000]))).toBe(false);
    expect(isDecodable(gifWithFrame([10, 10], [10, 10]))).toBe(true);
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
