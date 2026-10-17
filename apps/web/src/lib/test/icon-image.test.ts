// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isIconImage } from "@appstrate/core/appearance";
import {
  ICON_SOURCE_MAX_BYTES,
  ICON_SOURCE_TYPES,
  IconImageFailure,
  centerSquare,
  iconDataUri,
  iconImageErrorCode,
  iconSourceError,
  pickIconEncoding,
  type IconEncoder,
} from "../icon-image.ts";

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

// A 1×1 lossless WebP (`VP8L`), as `canvas.toBlob(…, "image/webp")` hands one back.
const WEBP_1X1_BASE64 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const WEBP_1X1 = bytesOf(WEBP_1X1_BASE64);
// A 1×1 PNG, as WebKit's `canvas.toBlob(…, "image/webp")` hands one back.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_1X1 = bytesOf(PNG_1X1_BASE64);

/** An encoder that records the sizes it was asked for and answers through `answer`. */
function recordingEncoder(answer: (size: number) => Blob | null) {
  const sizes: number[] = [];
  const encode: IconEncoder = async (size) => {
    sizes.push(size);
    return answer(size);
  };
  return { encode, sizes };
}

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

  it("refuses an SVG, which the picker does not offer either", () => {
    expect(iconSourceError({ type: "image/svg+xml", size: 10 })).toBe("icon_file_type");
    expect(ICON_SOURCE_TYPES.split(",")).not.toContain("image/svg+xml");
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
    const uri = iconDataUri("image/webp", WEBP_1X1);
    expect(uri).toBe(`data:image/webp;base64,${WEBP_1X1_BASE64}`);
    expect(isIconImage(uri)).toBe(true);
  });

  it("writes PNG bytes as a PNG data URI the API accepts", () => {
    const uri = iconDataUri("image/png", PNG_1X1);
    expect(uri).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(isIconImage(uri)).toBe(true);
  });
});

describe("pickIconEncoding", () => {
  it("keeps the WebP a browser encodes, at the first size", async () => {
    const { encode, sizes } = recordingEncoder(() => new Blob([WEBP_1X1], { type: "image/webp" }));
    expect(await pickIconEncoding(encode)).toBe(`data:image/webp;base64,${WEBP_1X1_BASE64}`);
    expect(sizes).toEqual([128]);
  });

  it("keeps the PNG WebKit hands back for a WebP, named as a PNG", async () => {
    const { encode, sizes } = recordingEncoder(() => new Blob([PNG_1X1], { type: "image/png" }));
    expect(await pickIconEncoding(encode)).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(sizes).toEqual([128]);
  });

  it("walks down the sizes until an encoding fits", async () => {
    const oversized = new Uint8Array(20_000);
    oversized.set(PNG_1X1);
    const { encode, sizes } = recordingEncoder((size) =>
      size === 64
        ? new Blob([PNG_1X1], { type: "image/png" })
        : new Blob([oversized], { type: "image/png" }),
    );
    expect(await pickIconEncoding(encode)).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(sizes).toEqual([128, 96, 64]);
  });

  it("goes down to 32 px for a photographic PNG that only fits there", async () => {
    const oversized = new Uint8Array(20_000);
    oversized.set(PNG_1X1);
    const { encode, sizes } = recordingEncoder((size) =>
      size === 32
        ? new Blob([PNG_1X1], { type: "image/png" })
        : new Blob([oversized], { type: "image/png" }),
    );
    expect(await pickIconEncoding(encode)).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect(sizes).toEqual([128, 96, 64, 48, 32]);
  });

  it("fails as a processing error on a foreign type at every size", async () => {
    const { encode, sizes } = recordingEncoder(
      () => new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }),
    );
    const failure = await pickIconEncoding(encode).catch((error: unknown) => error);
    expect(iconImageErrorCode(failure)).toBe("icon_processing");
    expect(sizes).toEqual([128, 96, 64, 48, 32]);
  });

  it("fails as a processing error when no size encodes at all", async () => {
    const { encode } = recordingEncoder(() => null);
    const failure = await pickIconEncoding(encode).catch((error: unknown) => error);
    expect(iconImageErrorCode(failure)).toBe("icon_processing");
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
