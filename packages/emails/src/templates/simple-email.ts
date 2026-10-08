// SPDX-License-Identifier: Apache-2.0

import { escapeHtml } from "@appstrate/core/html";
import type { RenderedEmail, SupportedLocale } from "../types.ts";

interface SimpleEmailStrings {
  subject: string;
  body: string;
  footer: string;
}

const validity = {
  fr: {
    sentence: "Ce lien expire dans {duration}.",
    minutes: (n: number) => `${n} minute${n > 1 ? "s" : ""}`,
    hours: (n: number) => `${n} heure${n > 1 ? "s" : ""}`,
  },
  en: {
    sentence: "This link expires in {duration}.",
    minutes: (n: number) => `${n} minute${n > 1 ? "s" : ""}`,
    hours: (n: number) => `${n} hour${n > 1 ? "s" : ""}`,
  },
} satisfies Record<SupportedLocale, unknown>;

/** "Ce lien expire dans 15 minutes." — whole hours are stated as hours. */
export function linkValiditySentence(expiresInMinutes: number, locale: SupportedLocale): string {
  const v = validity[locale] ?? validity.fr;
  const duration =
    expiresInMinutes % 60 === 0 ? v.hours(expiresInMinutes / 60) : v.minutes(expiresInMinutes);
  return v.sentence.replace("{duration}", duration);
}

/**
 * Factory for the link-based email renderers, which all share one HTML
 * structure: body text, a link, how long the link stays valid, and a footer.
 */
export function createSimpleEmailRenderer(
  strings: Record<SupportedLocale, SimpleEmailStrings>,
): (data: { url: string; locale: SupportedLocale; expiresInMinutes: number }) => RenderedEmail {
  return (data) => {
    const s = strings[data.locale] ?? strings.fr;

    const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(data.url)}">${escapeHtml(data.url)}</a></p>
<p>${linkValiditySentence(data.expiresInMinutes, data.locale)}</p>
<p>${s.footer}</p>`;

    return { subject: s.subject, html };
  };
}
