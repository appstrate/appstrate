import type { EmailPropsMap, RenderedEmail, SupportedLocale } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: "Réinitialisez votre mot de passe",
    body: "Cliquez sur le lien ci-dessous pour réinitialiser votre mot de passe :",
    footer: "Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.",
  },
  en: {
    subject: "Reset your password",
    body: "Click the link below to reset your password:",
    footer: "If you didn't request this reset, you can safely ignore this email.",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

export function renderResetPasswordEmail(props: EmailPropsMap["reset-password"]): RenderedEmail {
  const { url, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
<p>${s.footer}</p>`;

  return { subject: s.subject, html };
}
