import { marked } from "marked";
import DOMPurify from "dompurify";
import i18n from "../i18n";

marked.setOptions({ breaks: true, gfm: true });

export function convertMarkdown(text: string): string {
  if (!text) return "";
  const rawHtml = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml);
}

export function escapeHtml(str: string): string {
  return DOMPurify.sanitize(str, { ALLOWED_TAGS: [] });
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

export function formatDateField(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

export function formatDateShort(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function formatDateLong(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(i18n.language, {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}
