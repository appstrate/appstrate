import type { EmailPropsMap, RenderedEmail, SupportedLocale } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: "Votre lien de connexion",
    body: "Cliquez sur le lien ci-dessous pour vous connecter :",
    footer: "Si vous n'avez pas demandé ce lien, vous pouvez ignorer cet email.",
  },
  en: {
    subject: "Your sign-in link",
    body: "Click the link below to sign in:",
    footer: "If you didn't request this link, you can safely ignore this email.",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

export function renderMagicLinkEmail(props: EmailPropsMap["magic-link"]): RenderedEmail {
  const { url, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const subject = s.subject;

  const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
<p>${s.footer}</p>`;

  return { subject, html };
}
