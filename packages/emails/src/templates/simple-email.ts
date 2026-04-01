import type { RenderedEmail, SupportedLocale } from "../types.ts";
import { escapeHtml } from "./layout.ts";

interface SimpleEmailStrings {
  subject: string;
  body: string;
  footer: string;
}

/**
 * Factory for simple link-based email renderers.
 * All three templates (verification, reset-password, magic-link) share the same
 * HTML structure: body text, a link, and a footer.
 */
export function createSimpleEmailRenderer(
  strings: Record<SupportedLocale, SimpleEmailStrings>,
): (data: { url: string; locale: SupportedLocale }) => RenderedEmail {
  return (data) => {
    const s = strings[data.locale] ?? strings.fr;

    const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(data.url)}">${escapeHtml(data.url)}</a></p>
<p>${s.footer}</p>`;

    return { subject: s.subject, html };
  };
}
