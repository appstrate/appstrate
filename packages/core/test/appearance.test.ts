// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  APPEARANCE_COLORS,
  ICON_IMAGE_MAX_BYTES,
  IMAGE_ICON_PREFIX,
  appearanceColorSchema,
  appearanceIconSchema,
  derivedColor,
  isAppearanceColor,
  isEmoji,
  isIconImage,
  parseIcon,
  resolveColor,
  webpSize,
} from "../src/appearance.ts";

/** A RIFF/WEBP container whose first chunk is `fourCC` with `payload`, padded to `length`. */
function webp(fourCC: string, payload: number[], length = 0): Uint8Array {
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  const bytes = [
    ...ascii("RIFF"),
    ...u32(4 + 8 + payload.length),
    ...ascii("WEBP"),
    ...ascii(fourCC),
    ...u32(payload.length),
    ...payload,
  ];
  while (bytes.length < length) bytes.push(0);
  return Uint8Array.from(bytes);
}

const u24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];

function vp8x(width: number, height: number, length?: number): Uint8Array {
  return webp("VP8X", [0, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)], length);
}

function vp8l(width: number, height: number): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webp("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, bits >>> 24]);
}

function vp8(width: number, height: number): Uint8Array {
  return webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16(width), ...u16(height)]);
}

function dataUri(bytes: Uint8Array, prefix = IMAGE_ICON_PREFIX): string {
  return prefix + btoa(String.fromCharCode(...bytes));
}

describe("parseIcon", () => {
  it("reads a lucide id as a lucide name", () => {
    expect(parseIcon("lucide:calendar-clock")).toEqual({ kind: "lucide", name: "calendar-clock" });
  });

  it("reads any other Iconify id as an iconify id", () => {
    expect(parseIcon("logos:slack-icon")).toEqual({ kind: "iconify", id: "logos:slack-icon" });
    expect(parseIcon("simple-icons:googleforms")).toEqual({
      kind: "iconify",
      id: "simple-icons:googleforms",
    });
  });

  it("reads an http(s) URL or an image data URI as an URL", () => {
    expect(parseIcon("https://cdn.example.com/a.png")).toEqual({
      kind: "url",
      src: "https://cdn.example.com/a.png",
    });
    expect(parseIcon("data:image/webp;base64,AAAA")).toEqual({
      kind: "url",
      src: "data:image/webp;base64,AAAA",
    });
  });

  it("reads emoji:<one emoji> as an emoji", () => {
    expect(parseIcon("emoji:🚜")).toEqual({ kind: "emoji", emoji: "🚜" });
    expect(parseIcon("emoji:👩‍💻")).toEqual({ kind: "emoji", emoji: "👩‍💻" });
  });

  it("refuses what no surface can draw", () => {
    for (const value of [
      undefined,
      null,
      7,
      "",
      "bot",
      "assets/icon.png",
      "Logos:Slack",
      "a:b:c",
      "data:text/html,x",
      "🚜",
      "emoji:",
      "emoji:🚜🚜",
      "emoji:tractor",
    ]) {
      expect(parseIcon(value)).toBeNull();
    }
  });
});

describe("isEmoji", () => {
  it("accepts exactly one RGI emoji, sequences included", () => {
    for (const value of ["😀", "👩‍💻", "🇫🇷", "1️⃣", "👍🏽"]) {
      expect(isEmoji(value)).toBe(true);
    }
  });

  it("refuses text, several emojis, nothing, and a bare digit", () => {
    for (const value of ["a", "😀😀", "", "1"]) {
      expect(isEmoji(value)).toBe(false);
    }
  });
});

describe("palette", () => {
  it("knows its keys and nothing else", () => {
    for (const color of APPEARANCE_COLORS) expect(isAppearanceColor(color)).toBe(true);
    for (const value of ["red", "#336699", "", null, undefined, 3]) {
      expect(isAppearanceColor(value)).toBe(false);
    }
  });

  it("derives a stable hue, never neutral, spread over the hues", () => {
    expect(derivedColor("org_abc")).toBe(derivedColor("org_abc"));
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const color = derivedColor(`spc_${i}`);
      expect(color).not.toBe("neutral");
      expect(isAppearanceColor(color)).toBe(true);
      seen.add(color);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("resolves a valid key as is, anything else to the derived hue", () => {
    expect(resolveColor("neutral", "org_abc")).toBe("neutral");
    expect(resolveColor("rose", "org_abc")).toBe("rose");
    for (const value of [null, undefined, "red", 3]) {
      expect(resolveColor(value, "org_abc")).toBe(derivedColor("org_abc"));
    }
  });
});

describe("webpSize", () => {
  it("reads the canvas of a VP8X, VP8L and VP8 image", () => {
    expect(webpSize(vp8x(256, 128))).toEqual({ width: 256, height: 128 });
    expect(webpSize(vp8l(200, 16384))).toEqual({ width: 200, height: 16384 });
    expect(webpSize(vp8(64, 48))).toEqual({ width: 64, height: 48 });
  });

  it("ignores the scale bits of a VP8 frame", () => {
    expect(webpSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0xc0, 48, 0x40]))).toEqual({
      width: 64,
      height: 48,
    });
  });

  it("refuses a truncated header", () => {
    for (const bytes of [vp8x(16, 16), vp8l(16, 16), vp8(16, 16)]) {
      expect(webpSize(bytes.subarray(0, bytes.length - 1))).toBeNull();
    }
    expect(webpSize(new Uint8Array())).toBeNull();
  });

  it("refuses what is not a WebP image", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...vp8x(1, 1)]);
    expect(webpSize(png)).toBeNull();
    expect(webpSize(webp("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(webpSize(webp("VP8L", [0x00, 0, 0, 0, 0]))).toBeNull();
    expect(webpSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2b, 1, 0, 1, 0]))).toBeNull();
  });
});

describe("isIconImage", () => {
  it("accepts a small WebP data URI", () => {
    expect(isIconImage(dataUri(vp8x(256, 256)))).toBe(true);
    expect(isIconImage(dataUri(vp8l(32, 32)))).toBe(true);
    expect(isIconImage(dataUri(vp8(1, 1)))).toBe(true);
  });

  it("refuses another prefix", () => {
    expect(isIconImage(dataUri(vp8x(16, 16), "data:image/png;base64,"))).toBe(false);
    expect(isIconImage(dataUri(vp8x(16, 16), "data:image/webp,"))).toBe(false);
  });

  it("refuses text that is not strict base64", () => {
    const valid = dataUri(vp8x(16, 16));
    expect(isIconImage(IMAGE_ICON_PREFIX)).toBe(false);
    expect(isIconImage(`${valid.slice(0, -4)}AA-_`)).toBe(false);
    expect(isIconImage(`${valid} `)).toBe(false);
    expect(isIconImage(`${IMAGE_ICON_PREFIX}AAA==`)).toBe(false);
    expect(isIconImage(`${IMAGE_ICON_PREFIX}A===`)).toBe(false);
    expect(isIconImage(`${IMAGE_ICON_PREFIX}AA=A`)).toBe(false);
  });

  it("caps the decoded size", () => {
    expect(isIconImage(dataUri(vp8x(16, 16, ICON_IMAGE_MAX_BYTES)))).toBe(true);
    expect(isIconImage(dataUri(vp8x(16, 16, ICON_IMAGE_MAX_BYTES + 1)))).toBe(false);
  });

  it("caps the canvas", () => {
    expect(isIconImage(dataUri(vp8x(257, 16)))).toBe(false);
    expect(isIconImage(dataUri(vp8l(16, 257)))).toBe(false);
    expect(isIconImage(dataUri(vp8(0, 16)))).toBe(false);
  });

  it("refuses bytes that are not WebP", () => {
    expect(isIconImage(dataUri(Uint8Array.from([1, 2, 3, 4, 5, 6])))).toBe(false);
  });
});

describe("appearanceIconSchema", () => {
  const image = dataUri(vp8x(64, 64));

  it("accepts each allowed form", () => {
    const schema = appearanceIconSchema(["lucide", "emoji", "image"]);
    for (const value of ["lucide:bot", "lucide:calendar-clock", "emoji:🚜", image]) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it("refuses what is not one of the editable forms", () => {
    const schema = appearanceIconSchema(["lucide", "emoji", "image"]);
    for (const value of [
      "",
      "bot",
      "lucide:Bot",
      "lucide:",
      "logos:slack-icon",
      "https://cdn.example.com/a.png",
      "emoji:🚜🚜",
      "emoji:x",
      7,
      null,
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("refuses a form left out of the allowed set", () => {
    const lucideOrEmoji = appearanceIconSchema(["lucide", "emoji"]);
    expect(lucideOrEmoji.safeParse("emoji:🚜").success).toBe(true);
    expect(lucideOrEmoji.safeParse(image).success).toBe(false);

    const imageOnly = appearanceIconSchema(["image"]);
    expect(imageOnly.safeParse(image).success).toBe(true);
    expect(imageOnly.safeParse("lucide:bot").success).toBe(false);
    expect(imageOnly.safeParse("emoji:🚜").success).toBe(false);
  });

  it("names the allowed forms in its error", () => {
    const result = appearanceIconSchema(["lucide", "emoji"]).safeParse("bot");
    expect(result.error?.issues[0]?.message).toBe(
      "Icon must be lucide:<name> or emoji:<one emoji>",
    );
    const all = appearanceIconSchema(["lucide", "emoji", "image"]).safeParse("bot");
    expect(all.error?.issues[0]?.message).toBe(
      "Icon must be lucide:<name>, emoji:<one emoji> or a data:image/webp;base64 image " +
        "of at most 12000 bytes and 256×256 px",
    );
  });
});

describe("appearanceColorSchema", () => {
  it("accepts a palette key and nothing else", () => {
    for (const color of APPEARANCE_COLORS) {
      expect(appearanceColorSchema.safeParse(color).success).toBe(true);
    }
    for (const value of ["red", "#336699", "", null]) {
      expect(appearanceColorSchema.safeParse(value).success).toBe(false);
    }
  });
});
