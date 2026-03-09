export type DetectedType =
  | "markdown"
  | "url"
  | "email"
  | "date"
  | "boolean"
  | "number"
  | "image-url"
  | "list"
  | "object"
  | "text";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;
const URL_RE = /^https?:\/\//;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MARKDOWN_RE = /(?:^#{1,6}\s|[*_]{1,2}\S|\[.+]\(.+\)|```|^\s*[-*+]\s)/m;

export function isUrl(str: string): boolean {
  return URL_RE.test(str.trim());
}

export function isImageUrl(str: string): boolean {
  return isUrl(str) && IMAGE_EXT_RE.test(str.trim());
}

export function isEmail(str: string): boolean {
  return EMAIL_RE.test(str.trim());
}

export function isDateString(str: string): boolean {
  // ISO 8601 pattern or parseable date
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    return !isNaN(d.getTime());
  }
  return false;
}

export function isMarkdown(str: string): boolean {
  return MARKDOWN_RE.test(str);
}

export function detectValueType(value: unknown, _key?: string, schemaHint?: string): DetectedType {
  if (schemaHint) {
    const hint = schemaHint.toLowerCase();
    if (hint === "boolean") return "boolean";
    if (hint === "number" || hint === "integer") return "number";
    if (hint === "array") return "list";
    if (hint === "object") return "object";
  }

  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (value !== null && typeof value === "object") return "object";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isEmail(trimmed)) return "email";
    if (isImageUrl(trimmed)) return "image-url";
    if (isUrl(trimmed)) return "url";
    if (isDateString(trimmed)) return "date";
    if (trimmed.length > 80 && isMarkdown(trimmed)) return "markdown";
    return "text";
  }

  return "text";
}

export const TITLE_KEYS = ["title", "name", "subject", "label", "displayName", "display_name"];

export const INTERNAL_FIELDS = new Set(["state", "tokensUsed"]);

export function extractTitle(obj: Record<string, unknown>): string {
  for (const key of TITLE_KEYS) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
  }
  return "";
}

export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
