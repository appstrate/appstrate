// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  APPEARANCE_COLORS,
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_TYPES,
  appearanceColorSchema,
  appearanceIconSchema,
  derivedColor,
  imageSize,
  isAppearanceColor,
  isIconImage,
  normalizeEmoji,
  parseIcon,
  resolveColor,
} from "../src/appearance.ts";

const WEBP_PREFIX = "data:image/webp;base64,";
const PNG_PREFIX = "data:image/png;base64,";

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

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** A PNG signature and `IHDR` chunk for `width` × `height`, padded to `length`. */
function png(width: number, height: number, length = 0): Uint8Array {
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
    ...u32be(0),
  ];
  while (bytes.length < length) bytes.push(0);
  return Uint8Array.from(bytes);
}

function dataUri(bytes: Uint8Array, prefix = WEBP_PREFIX): string {
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

  it("draws an emoji: value as written, leaving RGI to the write side", () => {
    // Neither is RGI (a superfluous and a missing U+FE0F); both are drawable text.
    expect(parseIcon("emoji:\u{1F44D}\uFE0F")).toEqual({ kind: "emoji", emoji: "\u{1F44D}\uFE0F" });
    expect(parseIcon("emoji:\u2764")).toEqual({ kind: "emoji", emoji: "\u2764" });
    expect(parseIcon("emoji:🚜🚜")).toEqual({ kind: "emoji", emoji: "🚜🚜" });
    expect(parseIcon("emoji:🇫🇷")).toEqual({ kind: "emoji", emoji: "🇫🇷" });
    expect(parseIcon("emoji:1️⃣")).toEqual({ kind: "emoji", emoji: "1️⃣" });
    expect(parseIcon(`emoji:${"🚜".repeat(16)}`)).toEqual({
      kind: "emoji",
      emoji: "🚜".repeat(16),
    });
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
      "emoji: ",
      "emoji:🚜 🚜",
      "emoji:🚜\n",
      "emoji:abc",
      "emoji:1",
      `emoji:${"🚜".repeat(16)}x`,
    ]) {
      expect(parseIcon(value)).toBeNull();
    }
  });
});

describe("normalizeEmoji", () => {
  it("keeps exactly one RGI emoji as is, sequences included", () => {
    for (const value of ["😀", "👩‍💻", "🏳️‍🌈", "🇫🇷", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "1️⃣", "👍🏽", "❤️"]) {
      expect(normalizeEmoji(value)).toBe(value);
    }
  });

  it("drops a U+FE0F the emoji does not take (Emojibase's raw form)", () => {
    expect(normalizeEmoji("\u{1F44D}\uFE0F")).toBe("\u{1F44D}"); // 👍️
    expect(normalizeEmoji("\u2615\uFE0F")).toBe("\u2615"); // ☕️
    expect(normalizeEmoji("\u{1F610}\uFE0F")).toBe("\u{1F610}"); // 😐️
  });

  it("adds the U+FE0F a text-default code point needs", () => {
    expect(normalizeEmoji("\u2764")).toBe("\u2764\uFE0F"); // ❤ → ❤️
    expect(normalizeEmoji("\u263A")).toBe("\u263A\uFE0F"); // ☺ → ☺️
  });

  it("qualifies a minimally-qualified sequence", () => {
    for (const [value, rgi] of [
      ["1\u20E3", "1\uFE0F\u20E3"], // 1⃣ → 1️⃣
      ["#\u20E3", "#\uFE0F\u20E3"], // #⃣ → #️⃣
      ["\u{1F3F3}\u200D\u{1F308}", "\u{1F3F3}\uFE0F\u200D\u{1F308}"], // 🏳‍🌈 → 🏳️‍🌈
      ["\u2764\u200D\u{1F525}", "\u2764\uFE0F\u200D\u{1F525}"], // ❤‍🔥 → ❤️‍🔥
      ["\u{1F441}\u200D\u{1F5E8}", "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F"], // 👁‍🗨 → 👁️‍🗨️
      ["\u{1F642}\u200D\u2194", "\u{1F642}\u200D\u2194\uFE0F"], // 🙂‍↔ → 🙂‍↔️
      ["\u{1F441}\uFE0F\u200D\u{1F5E8}", "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F"], // half-qualified
    ]) {
      expect(normalizeEmoji(value!)).toBe(rgi!);
    }
  });

  it("adds no U+FE0F before a skin-tone modifier", () => {
    expect(normalizeEmoji("\u261D\u{1F3FD}")).toBe("\u261D\u{1F3FD}"); // ☝🏽
    expect(normalizeEmoji("\u{1F575}\u{1F3FD}\u200D\u2642")).toBe(
      "\u{1F575}\u{1F3FD}\u200D\u2642\uFE0F", // 🕵🏽‍♂ → 🕵🏽‍♂️
    );
  });

  it("refuses text, several emojis, nothing, and a bare digit", () => {
    for (const value of ["a", "😀😀", "", "1", "1\uFE0F", "tractor", "\uFE0F", "👍 "]) {
      expect(normalizeEmoji(value)).toBeNull();
    }
  });

  it("refuses a value longer than any emoji before looking at it", () => {
    expect(normalizeEmoji("\u2764".repeat(33))).toBeNull();
    expect(normalizeEmoji("\uFE0F".repeat(31) + "\u2764")).toBe("\u2764\uFE0F");
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

describe("imageSize", () => {
  it("reads the canvas of a VP8X, VP8L and VP8 image", () => {
    expect(imageSize(vp8x(256, 128))).toEqual({ type: "image/webp", width: 256, height: 128 });
    expect(imageSize(vp8l(200, 16384))).toEqual({
      type: "image/webp",
      width: 200,
      height: 16384,
    });
    expect(imageSize(vp8(64, 48))).toEqual({ type: "image/webp", width: 64, height: 48 });
  });

  it("ignores the scale bits of a VP8 frame", () => {
    expect(imageSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0xc0, 48, 0x40]))).toEqual({
      type: "image/webp",
      width: 64,
      height: 48,
    });
  });

  it("reads the size of a PNG image from its IHDR chunk", () => {
    expect(imageSize(png(256, 128))).toEqual({ type: "image/png", width: 256, height: 128 });
    expect(imageSize(png(0x01020304, 1))).toEqual({
      type: "image/png",
      width: 0x01020304,
      height: 1,
    });
    // Only the signature and IHDR header are read: bytes 0–23.
    expect(imageSize(png(16, 16).subarray(0, 24))).toEqual({
      type: "image/png",
      width: 16,
      height: 16,
    });
  });

  it("refuses a truncated header", () => {
    for (const bytes of [vp8x(16, 16), vp8l(16, 16), vp8(16, 16)]) {
      expect(imageSize(bytes.subarray(0, bytes.length - 1))).toBeNull();
    }
    for (const length of [23, 16, 8, 4]) {
      expect(imageSize(png(16, 16).subarray(0, length))).toBeNull();
    }
    expect(imageSize(new Uint8Array())).toBeNull();
  });

  it("refuses what is neither a WebP nor a PNG image", () => {
    const pngThenWebp = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...vp8x(1, 1),
    ]);
    expect(imageSize(pngThenWebp)).toBeNull();
    expect(imageSize(webp("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(imageSize(webp("VP8L", [0x00, 0, 0, 0, 0]))).toBeNull();
    expect(imageSize(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2b, 1, 0, 1, 0]))).toBeNull();
    // A PNG whose first chunk is not a 13-byte IHDR.
    const notIhdr = png(16, 16);
    notIhdr.set([0x49, 0x44, 0x41, 0x54], 12); // IDAT
    expect(imageSize(notIhdr)).toBeNull();
    const badLength = png(16, 16);
    badLength.set(u32be(14), 8);
    expect(imageSize(badLength)).toBeNull();
    const riffNotWebp = webp("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    riffNotWebp.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(imageSize(riffNotWebp)).toBeNull();
  });
});

describe("isIconImage", () => {
  it("names the types it accepts", () => {
    expect(ICON_IMAGE_TYPES).toEqual(["image/webp", "image/png"]);
  });

  it("accepts a small WebP or PNG data URI", () => {
    expect(isIconImage(dataUri(vp8x(256, 256)))).toBe(true);
    expect(isIconImage(dataUri(vp8l(32, 32)))).toBe(true);
    expect(isIconImage(dataUri(vp8(1, 1)))).toBe(true);
    expect(isIconImage(dataUri(png(256, 256), PNG_PREFIX))).toBe(true);
    expect(isIconImage(dataUri(png(1, 1), PNG_PREFIX))).toBe(true);
  });

  it("refuses another prefix, or a type the bytes are not", () => {
    expect(isIconImage(dataUri(vp8x(16, 16), "data:image/jpeg;base64,"))).toBe(false);
    expect(isIconImage(dataUri(vp8x(16, 16), "data:image/webp,"))).toBe(false);
    expect(isIconImage(dataUri(png(16, 16), "data:image/png,"))).toBe(false);
    expect(isIconImage(dataUri(vp8x(16, 16), PNG_PREFIX))).toBe(false);
    expect(isIconImage(dataUri(png(16, 16), WEBP_PREFIX))).toBe(false);
  });

  it("refuses text that is not strict base64", () => {
    const valid = dataUri(vp8x(16, 16));
    expect(isIconImage(WEBP_PREFIX)).toBe(false);
    expect(isIconImage(PNG_PREFIX)).toBe(false);
    expect(isIconImage(`${valid.slice(0, -4)}AA-_`)).toBe(false);
    expect(isIconImage(`${valid} `)).toBe(false);
    expect(isIconImage(`${WEBP_PREFIX}AAA==`)).toBe(false);
    expect(isIconImage(`${WEBP_PREFIX}A===`)).toBe(false);
    expect(isIconImage(`${WEBP_PREFIX}AA=A`)).toBe(false);
  });

  it("caps the decoded size", () => {
    expect(isIconImage(dataUri(vp8x(16, 16, ICON_IMAGE_MAX_BYTES)))).toBe(true);
    expect(isIconImage(dataUri(vp8x(16, 16, ICON_IMAGE_MAX_BYTES + 1)))).toBe(false);
    expect(isIconImage(dataUri(png(16, 16, ICON_IMAGE_MAX_BYTES), PNG_PREFIX))).toBe(true);
    expect(isIconImage(dataUri(png(16, 16, ICON_IMAGE_MAX_BYTES + 1), PNG_PREFIX))).toBe(false);
  });

  it("caps the canvas", () => {
    expect(isIconImage(dataUri(vp8x(257, 16)))).toBe(false);
    expect(isIconImage(dataUri(vp8l(16, 257)))).toBe(false);
    expect(isIconImage(dataUri(vp8(0, 16)))).toBe(false);
    expect(isIconImage(dataUri(png(257, 16), PNG_PREFIX))).toBe(false);
    expect(isIconImage(dataUri(png(16, 257), PNG_PREFIX))).toBe(false);
    expect(isIconImage(dataUri(png(0, 16), PNG_PREFIX))).toBe(false);
    expect(isIconImage(dataUri(png(0xffffffff, 16), PNG_PREFIX))).toBe(false);
  });

  it("refuses bytes that are not an image, or a truncated one", () => {
    expect(isIconImage(dataUri(Uint8Array.from([1, 2, 3, 4, 5, 6])))).toBe(false);
    expect(isIconImage(dataUri(png(16, 16).subarray(0, 23), PNG_PREFIX))).toBe(false);
  });
});

describe("appearanceIconSchema", () => {
  const image = dataUri(vp8x(64, 64));
  const pngImage = dataUri(png(64, 64), PNG_PREFIX);

  it("accepts each allowed form, as is", () => {
    const schema = appearanceIconSchema(["lucide", "emoji", "image"]);
    for (const value of [
      "lucide:bot",
      "lucide:calendar-clock",
      "emoji:🚜",
      "emoji:👩‍💻",
      "emoji:🇫🇷",
      image,
      pngImage,
    ]) {
      expect(schema.safeParse(value)).toEqual({ success: true, data: value });
    }
  });

  it("stores an emoji in its RGI form", () => {
    const schema = appearanceIconSchema(["lucide", "emoji"]);
    expect(schema.parse("emoji:\u{1F44D}\uFE0F")).toBe("emoji:\u{1F44D}"); // 👍️ → 👍
    expect(schema.parse("emoji:\u2615\uFE0F")).toBe("emoji:\u2615"); // ☕️ → ☕
    expect(schema.parse("emoji:\u2764")).toBe("emoji:\u2764\uFE0F"); // ❤ → ❤️
    expect(schema.parse("emoji:1\u20E3")).toBe("emoji:1\uFE0F\u20E3"); // 1⃣ → 1️⃣
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
      "emoji:",
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
    expect(imageOnly.safeParse(pngImage).success).toBe(true);
    expect(imageOnly.safeParse("lucide:bot").success).toBe(false);
    expect(imageOnly.safeParse("emoji:🚜").success).toBe(false);
  });

  it("refuses a value longer than the database allows, whatever its form", () => {
    const schema = appearanceIconSchema(["lucide", "emoji", "image"]);
    expect(schema.safeParse(`lucide:${"a".repeat(16_384)}`).success).toBe(false);
    // Refused by the length, before the image check scans it.
    const image = schema.safeParse(`${WEBP_PREFIX}${"A".repeat(16_384)}`);
    expect(image.error?.issues.map((issue) => issue.code)).toEqual(["too_big"]);
  });

  it("names the allowed forms in its error", () => {
    const result = appearanceIconSchema(["lucide", "emoji"]).safeParse("bot");
    expect(result.error?.issues[0]?.message).toBe(
      "Icon must be lucide:<name> or emoji:<one emoji>",
    );
    const all = appearanceIconSchema(["lucide", "emoji", "image"]).safeParse("bot");
    expect(all.error?.issues[0]?.message).toBe(
      "Icon must be lucide:<name>, emoji:<one emoji> or a data:image/webp;base64 or " +
        "data:image/png;base64 image of at most 12000 bytes and 256×256 px",
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
