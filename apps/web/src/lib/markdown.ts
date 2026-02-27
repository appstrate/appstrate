import { marked } from "marked";
import DOMPurify from "dompurify";
import i18n from "../i18n";

marked.setOptions({ breaks: true, gfm: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")?.startsWith("http")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function convertMarkdown(text: string): string {
  if (!text) return "";
  const rawHtml = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["target", "rel"] });
}

export function escapeHtml(str: string): string {
  return DOMPurify.sanitize(str, { ALLOWED_TAGS: [] });
}

export function linkifyText(str: string): string {
  if (!str) return "";
  const rawHtml = marked.parseInline(str, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["target", "rel"] });
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

export function formatDateField(dateStr: string | Date): string {
  try {
    const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
    return d.toLocaleString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(dateStr);
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
