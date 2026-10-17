// SPDX-License-Identifier: Apache-2.0

/**
 * The visual identity of an agent, a space or an organization: one icon and
 * one colour, read and written through the same grammar everywhere.
 *
 * AFPS reads a manifest `icon` as an archive path to a PNG or an absolute URI.
 * Appstrate writes URI forms there, and stores the same forms for a space or an
 * organization:
 * - an image URL — `http(s)://…`, or a `data:image/…` URI, the form an uploaded
 *   organization icon takes (`data:image/webp;base64,…` or
 *   `data:image/png;base64,…`, see `ICON_IMAGE_TYPES`);
 * - an Iconify icon id (`<prefix>:<name>`, e.g. `logos:slack-icon`), whose
 *   prefix stands as the URI scheme. The `lucide` prefix is singled out because
 *   an Appstrate surface draws it from its own bundle rather than from the
 *   Iconify API — it is the set a picked icon comes from;
 * - `emoji:<one emoji>`, the prefix again standing as the scheme.
 *
 * Reading is lenient (`parseIcon`: anything a surface cannot draw is `null`,
 * and an `emoji:` value carrying a pictograph is taken as the text to draw
 * without asking which emoji it is); writing is strict (`appearanceIconSchema`: only the forms an
 * editor offers, an emoji checked against Unicode's RGI set and stored in its
 * canonical form by `normalizeEmoji`). The split is load-bearing: the strict
 * check needs a `v`-flag regular expression, which older browsers cannot even
 * compile, so it is built on first use, on the write side only, and loading
 * this module or reading an icon never touches it.
 */

import { z } from "zod";

/** Iconify prefix of the Lucide set: `lucide:bot`. */
export const LUCIDE_ICON_PREFIX = "lucide:";

/** Prefix of an emoji icon: `emoji:🚜`. */
export const EMOJI_ICON_PREFIX = "emoji:";

/**
 * The image types an uploaded icon may take, each written as a base64 data URI
 * (`data:<type>;base64,…`). PNG beside WebP because WebKit's canvas cannot
 * encode WebP: asked for one, it returns a PNG.
 */
export const ICON_IMAGE_TYPES = ["image/webp", "image/png"] as const;

type IconImageType = (typeof ICON_IMAGE_TYPES)[number];

export type AppearanceIcon =
  | { kind: "lucide"; name: string }
  | { kind: "iconify"; id: string }
  | { kind: "url"; src: string }
  | { kind: "emoji"; emoji: string };

/** A lowercase kebab-case name, the name part of an Iconify id. */
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An Iconify id: a lowercase prefix and name, kebab-case, joined by one colon. */
const ICONIFY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Longest `emoji:` text a reader draws, in UTF-16 code units. The longest RGI
 * emoji (a skin-toned couple sequence) is 15; anything far past that is not one.
 */
const EMOJI_MAX_LENGTH = 32;

/**
 * A code point only an emoji carries: a pictograph, a regional indicator (half
 * a flag) or the keycap mark U+20E3. A `u`-flag expression (ES2018), which
 * every browser the SPA targets compiles.
 */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/** U+FE0F VARIATION SELECTOR-16, which asks for the emoji presentation. */
const EMOJI_PRESENTATION = "\uFE0F";
const EMOJI_PRESENTATIONS = /\uFE0F/g;

let rgiEmoji: RegExp | undefined;

/**
 * Exactly one RGI emoji — a ZWJ sequence, flag, keycap or skin-toned emoji
 * counts as one. The expression is compiled on first call, never at module
 * load: the `v` flag throws a `SyntaxError` on Safari before 17, Firefox
 * before 116 and Chrome before 112, and the reading side must work there. A
 * string, not a literal, for the same reason, and because consumers
 * type-check this file at ES2020.
 */
function isRgiEmoji(value: string): boolean {
  rgiEmoji ??= new RegExp("^\\p{RGI_Emoji}$", "v");
  return rgiEmoji.test(value);
}

/**
 * The RGI form of one emoji, or `null` when `value` is not one. Pickers and
 * keyboards emit near misses Unicode does not list: a U+FE0F after a code point
 * that is an emoji by default (Emojibase's `👍️`, `☕️`), or none after one
 * that needs it (`❤`). Tried in order, the first RGI candidate wins: `value`
 * as is; `value` with every U+FE0F removed; that, when it is one code point,
 * with U+FE0F appended.
 */
export function normalizeEmoji(value: string): string | null {
  if (value === "") return null;
  // `replace` with a global expression, not `replaceAll`: consumers type-check at ES2020.
  const bare = value.replace(EMOJI_PRESENTATIONS, "");
  const candidates = [value, bare];
  if ([...bare].length === 1) candidates.push(`${bare}${EMOJI_PRESENTATION}`);
  return candidates.find(isRgiEmoji) ?? null;
}

/**
 * Reads an `icon`. `null` for anything a surface cannot draw: no value, an
 * archive path (the platform serves no package asset), a bare name, or an
 * `emoji:` value that holds whitespace, is longer than any emoji, or carries
 * no pictograph (`emoji:abc`, from a hand-written manifest). An `emoji:` value
 * is otherwise drawn as written (`❤` without its U+FE0F included): whether it
 * is exactly one RGI emoji is the write side's question
 * (`appearanceIconSchema`), not the reader's.
 */
export function parseIcon(value: unknown): AppearanceIcon | null {
  if (typeof value !== "string" || value === "") return null;
  if (/^https?:\/\//.test(value) || value.startsWith("data:image/")) {
    return { kind: "url", src: value };
  }
  if (value.startsWith(EMOJI_ICON_PREFIX)) {
    const emoji = value.slice(EMOJI_ICON_PREFIX.length);
    if (emoji.length > EMOJI_MAX_LENGTH || /\s/.test(emoji) || !PICTOGRAPH.test(emoji)) {
      return null;
    }
    return { kind: "emoji", emoji };
  }
  if (!ICONIFY_ID.test(value)) return null;
  if (value.startsWith(LUCIDE_ICON_PREFIX)) {
    return { kind: "lucide", name: value.slice(LUCIDE_ICON_PREFIX.length) };
  }
  return { kind: "iconify", id: value };
}

/** The palette: `neutral`, then the eight hues a derived colour is drawn from. */
export const APPEARANCE_COLORS = [
  "neutral",
  "blue",
  "emerald",
  "violet",
  "amber",
  "rose",
  "cyan",
  "pink",
  "orange",
] as const;

export type AppearanceColor = (typeof APPEARANCE_COLORS)[number];

const HUES = APPEARANCE_COLORS.filter((color) => color !== "neutral");

export function isAppearanceColor(value: unknown): value is AppearanceColor {
  return (APPEARANCE_COLORS as readonly unknown[]).includes(value);
}

/** A hue picked by a stable hash of `seed` (an entity id) — never `neutral`. */
export function derivedColor(seed: string): AppearanceColor {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return HUES[Math.abs(hash) % HUES.length]!;
}

/**
 * The colour to draw. A stored `null` (or anything unreadable) means "derived
 * from the entity id", so `seed` is that id; `neutral` is an explicit choice.
 */
export function resolveColor(color: unknown, seed: string): AppearanceColor {
  return isAppearanceColor(color) ? color : derivedColor(seed);
}

/** Largest uploaded icon image, in decoded bytes. */
export const ICON_IMAGE_MAX_BYTES = 12_000;

/** Largest uploaded icon image width and height, in pixels. */
export const ICON_IMAGE_MAX_SIZE = 256;

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** The 8-byte signature every PNG file starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The size of a PNG image, read from its `IHDR` chunk, which the format
 * requires first: after the signature, its length (13), `IHDR`, then the width
 * and height as big-endian 32-bit integers (bytes 16–19 and 20–23).
 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const u32 = (i: number) =>
    ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  if (u32(8) !== 13 || fourCC(bytes, 12) !== "IHDR") return null;
  return { width: u32(16), height: u32(20) };
}

/**
 * The canvas size of a WebP image, read from its first chunk (`VP8X`, `VP8L`
 * or `VP8 `) of the RIFF/WEBP container.
 */
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20 || fourCC(bytes, 8) !== "WEBP") return null;
  const b = (i: number) => bytes[i]!;
  switch (fourCC(bytes, 12)) {
    case "VP8X": {
      if (bytes.length < 30) return null;
      return {
        width: 1 + (b(24) | (b(25) << 8) | (b(26) << 16)),
        height: 1 + (b(27) | (b(28) << 8) | (b(29) << 16)),
      };
    }
    case "VP8L": {
      if (bytes.length < 25 || b(20) !== 0x2f) return null;
      const bits = (b(21) | (b(22) << 8) | (b(23) << 16) | (b(24) << 24)) >>> 0;
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    case "VP8 ": {
      if (bytes.length < 30) return null;
      if (b(23) !== 0x9d || b(24) !== 0x01 || b(25) !== 0x2a) return null;
      return {
        width: (b(26) | (b(27) << 8)) & 0x3fff,
        height: (b(28) | (b(29) << 8)) & 0x3fff,
      };
    }
    default:
      return null;
  }
}

/**
 * The type and size of an icon image, told apart by its signature: a PNG
 * (`IHDR`) or a RIFF/WEBP container (`VP8X`, `VP8L` or `VP8 `). `null` for any
 * other bytes, or a header that cannot be read in full.
 */
export function imageSize(
  bytes: Uint8Array,
): { type: IconImageType; width: number; height: number } | null {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    const size = pngSize(bytes);
    return size && { type: "image/png", ...size };
  }
  if (bytes.length >= 4 && fourCC(bytes, 0) === "RIFF") {
    const size = webpSize(bytes);
    return size && { type: "image/webp", ...size };
  }
  return null;
}

/** Longest base64 text that can decode to at most `ICON_IMAGE_MAX_BYTES`. */
const ICON_IMAGE_MAX_BASE64 = Math.ceil(ICON_IMAGE_MAX_BYTES / 3) * 4;

const dataUriPrefix = (type: IconImageType) => `data:${type};base64,`;

/**
 * An uploaded icon image: a base64 data URI of one of `ICON_IMAGE_TYPES`,
 * whose bytes are that type, at most `ICON_IMAGE_MAX_BYTES`, its canvas at most
 * `ICON_IMAGE_MAX_SIZE` square.
 */
export function isIconImage(value: string): boolean {
  const type = ICON_IMAGE_TYPES.find((candidate) => value.startsWith(dataUriPrefix(candidate)));
  if (type === undefined) return false;
  const base64 = value.slice(dataUriPrefix(type).length);
  if (base64 === "" || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return false;
  }
  // Size first, so an oversized value is never decoded.
  if (base64.length > ICON_IMAGE_MAX_BASE64) return false;
  const binary = atob(base64);
  if (binary.length > ICON_IMAGE_MAX_BYTES) return false;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const size = imageSize(bytes);
  return (
    size !== null &&
    size.type === type &&
    size.width >= 1 &&
    size.width <= ICON_IMAGE_MAX_SIZE &&
    size.height >= 1 &&
    size.height <= ICON_IMAGE_MAX_SIZE
  );
}

/** The icon forms an editor can write. */
export type IconForm = "lucide" | "emoji" | "image";

/** Per form: the value as stored when the form accepts it (else `null`), and its name in errors. */
const ICON_FORMS: Record<IconForm, { canonical: (value: string) => string | null; label: string }> =
  {
    lucide: {
      canonical: (value) =>
        value.startsWith(LUCIDE_ICON_PREFIX) &&
        ICON_NAME.test(value.slice(LUCIDE_ICON_PREFIX.length))
          ? value
          : null,
      label: "lucide:<name>",
    },
    emoji: {
      canonical: (value) => {
        if (!value.startsWith(EMOJI_ICON_PREFIX)) return null;
        const emoji = normalizeEmoji(value.slice(EMOJI_ICON_PREFIX.length));
        return emoji === null ? null : `${EMOJI_ICON_PREFIX}${emoji}`;
      },
      label: "emoji:<one emoji>",
    },
    image: {
      canonical: (value) => (isIconImage(value) ? value : null),
      label:
        `a ${ICON_IMAGE_TYPES.map((type) => dataUriPrefix(type).slice(0, -1)).join(" or ")} ` +
        `image of at most ${ICON_IMAGE_MAX_BYTES} bytes and ` +
        `${ICON_IMAGE_MAX_SIZE}×${ICON_IMAGE_MAX_SIZE} px`,
    },
  };

/**
 * An icon written through an editor: one of `forms`, nothing else, parsed to
 * the value to store — an emoji in its RGI form (`emoji:👍️` → `emoji:👍`).
 */
export function appearanceIconSchema(forms: readonly IconForm[]) {
  const labels = forms.map((form) => ICON_FORMS[form].label);
  const last = labels.pop() ?? "";
  const allowed = labels.length > 0 ? `${labels.join(", ")} or ${last}` : last;
  return z.string().transform((value, ctx) => {
    for (const form of forms) {
      const canonical = ICON_FORMS[form].canonical(value);
      if (canonical !== null) return canonical;
    }
    ctx.addIssue({ code: "custom", message: `Icon must be ${allowed}` });
    return z.NEVER;
  });
}

export const appearanceColorSchema = z.enum(APPEARANCE_COLORS);
