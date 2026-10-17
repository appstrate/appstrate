// SPDX-License-Identifier: Apache-2.0

/**
 * The visual identity of an agent, a space or an organization: one icon and
 * one colour, read and written through the same grammar everywhere.
 *
 * AFPS reads a manifest `icon` as an archive path to a PNG or an absolute URI.
 * Appstrate writes URI forms there, and stores the same forms for a space or an
 * organization:
 * - an image URL — `http(s)://…`, or a `data:image/…` URI, the form an uploaded
 *   organization icon takes (`data:image/webp;base64,…`);
 * - an Iconify icon id (`<prefix>:<name>`, e.g. `logos:slack-icon`), whose
 *   prefix stands as the URI scheme. The `lucide` prefix is singled out because
 *   an Appstrate surface draws it from its own bundle rather than from the
 *   Iconify API — it is the set a picked icon comes from;
 * - `emoji:<one emoji>`, the prefix again standing as the scheme.
 *
 * Reading is lenient (`parseIcon`: anything undrawable is `null`); writing is
 * strict (`appearanceIconSchema`: only the forms an editor offers).
 */

import { z } from "zod";

/** Iconify prefix of the Lucide set: `lucide:bot`. */
export const LUCIDE_ICON_PREFIX = "lucide:";

/** Prefix of an emoji icon: `emoji:🚜`. */
export const EMOJI_ICON_PREFIX = "emoji:";

/** Prefix of an uploaded icon image: a base64 WebP data URI. */
export const IMAGE_ICON_PREFIX = "data:image/webp;base64,";

export type AppearanceIcon =
  | { kind: "lucide"; name: string }
  | { kind: "iconify"; id: string }
  | { kind: "url"; src: string }
  | { kind: "emoji"; emoji: string };

/** A lowercase kebab-case name, the name part of an Iconify id. */
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An Iconify id: a lowercase prefix and name, kebab-case, joined by one colon. */
const ICONIFY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A string, not a literal: consumers type-check this file at ES2020, which rejects the `v` flag.
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

/** Exactly one RGI emoji — a ZWJ sequence, flag, keycap or skin-toned emoji counts as one. */
export function isEmoji(value: string): boolean {
  return RGI_EMOJI.test(value);
}

/**
 * Reads an `icon`. `null` for anything a surface cannot draw: no value, an
 * archive path (the platform serves no package asset), a bare name, or an
 * `emoji:` value that is not exactly one emoji.
 */
export function parseIcon(value: unknown): AppearanceIcon | null {
  if (typeof value !== "string" || value === "") return null;
  if (/^https?:\/\//.test(value) || value.startsWith("data:image/")) {
    return { kind: "url", src: value };
  }
  if (value.startsWith(EMOJI_ICON_PREFIX)) {
    const emoji = value.slice(EMOJI_ICON_PREFIX.length);
    return isEmoji(emoji) ? { kind: "emoji", emoji } : null;
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

/** Largest uploaded icon image, in decoded WebP bytes. */
export const ICON_IMAGE_MAX_BYTES = 12_000;

/** Largest uploaded icon image width and height, in pixels. */
export const ICON_IMAGE_MAX_SIZE = 256;

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * The canvas size of a WebP image, read from its first chunk (`VP8X`, `VP8L`
 * or `VP8 `). `null` unless the bytes are a RIFF/WEBP container whose header
 * can be read in full.
 */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  if (fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WEBP") return null;
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

/** Longest base64 text that can decode to at most `ICON_IMAGE_MAX_BYTES`. */
const ICON_IMAGE_MAX_BASE64 = Math.ceil(ICON_IMAGE_MAX_BYTES / 3) * 4;

/**
 * An uploaded icon image: a base64 WebP data URI of at most
 * `ICON_IMAGE_MAX_BYTES`, its canvas at most `ICON_IMAGE_MAX_SIZE` square.
 */
export function isIconImage(value: string): boolean {
  if (!value.startsWith(IMAGE_ICON_PREFIX)) return false;
  const base64 = value.slice(IMAGE_ICON_PREFIX.length);
  if (base64 === "" || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return false;
  }
  // Size first, so an oversized value is never decoded.
  if (base64.length > ICON_IMAGE_MAX_BASE64) return false;
  const binary = atob(base64);
  if (binary.length > ICON_IMAGE_MAX_BYTES) return false;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const size = webpSize(bytes);
  return (
    size !== null &&
    size.width >= 1 &&
    size.width <= ICON_IMAGE_MAX_SIZE &&
    size.height >= 1 &&
    size.height <= ICON_IMAGE_MAX_SIZE
  );
}

/** The icon forms an editor can write. */
export type IconForm = "lucide" | "emoji" | "image";

const ICON_FORMS: Record<IconForm, { accepts: (value: string) => boolean; label: string }> = {
  lucide: {
    accepts: (value) =>
      value.startsWith(LUCIDE_ICON_PREFIX) &&
      ICON_NAME.test(value.slice(LUCIDE_ICON_PREFIX.length)),
    label: "lucide:<name>",
  },
  emoji: {
    accepts: (value) =>
      value.startsWith(EMOJI_ICON_PREFIX) && isEmoji(value.slice(EMOJI_ICON_PREFIX.length)),
    label: "emoji:<one emoji>",
  },
  image: {
    accepts: isIconImage,
    label:
      `a ${IMAGE_ICON_PREFIX.slice(0, -1)} image of at most ${ICON_IMAGE_MAX_BYTES} bytes ` +
      `and ${ICON_IMAGE_MAX_SIZE}×${ICON_IMAGE_MAX_SIZE} px`,
  },
};

/** An icon written through an editor: one of `forms`, nothing else. */
export function appearanceIconSchema(forms: readonly IconForm[]) {
  const labels = forms.map((form) => ICON_FORMS[form].label);
  const last = labels.pop() ?? "";
  const allowed = labels.length > 0 ? `${labels.join(", ")} or ${last}` : last;
  return z.string().refine((value) => forms.some((form) => ICON_FORMS[form].accepts(value)), {
    error: `Icon must be ${allowed}`,
  });
}

export const appearanceColorSchema = z.enum(APPEARANCE_COLORS);
