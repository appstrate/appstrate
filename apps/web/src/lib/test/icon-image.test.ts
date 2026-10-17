// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isIconImage } from "@appstrate/core/appearance";
import {
  ICON_SOURCE_MAX_BYTES,
  IconImageFailure,
  centerSquare,
  iconDataUri,
  iconImageErrorCode,
  iconSourceError,
} from "../icon-image.ts";

// A 1×1 lossless WebP (`VP8L`), as `canvas.toBlob(…, "image/webp")` hands one back.
const WEBP_1X1 = Uint8Array.from(atob("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="), (char) =>
  char.charCodeAt(0),
);

describe("iconSourceError", () => {
  it("refuses a file that is not an image", () => {
    expect(iconSourceError({ type: "application/pdf", size: 10 })).toBe("icon_file_type");
  });

  it("refuses an image over the source limit", () => {
    expect(iconSourceError({ type: "image/png", size: ICON_SOURCE_MAX_BYTES + 1 })).toBe(
      "icon_file_size",
    );
  });

  it("accepts an image within the limit", () => {
    expect(iconSourceError({ type: "image/jpeg", size: ICON_SOURCE_MAX_BYTES })).toBeNull();
  });
});

describe("centerSquare", () => {
  it("crops the middle of a landscape image", () => {
    expect(centerSquare(300, 100)).toEqual({ x: 100, y: 0, size: 100 });
  });

  it("crops the middle of a portrait image", () => {
    expect(centerSquare(100, 300)).toEqual({ x: 0, y: 100, size: 100 });
  });
});

describe("iconDataUri", () => {
  it("writes WebP bytes as the icon data URI the API accepts", () => {
    const uri = iconDataUri(WEBP_1X1);
    expect(uri).toBe("data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==");
    expect(isIconImage(uri)).toBe(true);
  });

  it("writes other bytes that isIconImage then refuses", () => {
    expect(isIconImage(iconDataUri(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))).toBe(false);
  });
});

describe("iconImageErrorCode", () => {
  it("reads the code an encoder failure carries", () => {
    expect(iconImageErrorCode(new IconImageFailure("icon_file_size"))).toBe("icon_file_size");
  });

  it("reads anything else as a processing failure", () => {
    expect(iconImageErrorCode(new Error("icon_file_type"))).toBe("icon_processing");
    expect(iconImageErrorCode("boom")).toBe("icon_processing");
  });
});
