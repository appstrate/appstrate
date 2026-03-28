import type { EmailPropsMap, RenderedEmail, SupportedLocale } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: "Vérifiez votre adresse email",
    body: "Cliquez sur le lien ci-dessous pour vérifier votre adresse email :",
    footer: "Si vous n'avez pas créé de compte, ignorez cet email.",
  },
  en: {
    subject: "Verify your email address",
    body: "Click the link below to verify your email address:",
    footer: "If you did not create an account, ignore this email.",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

export function renderVerificationEmail(props: EmailPropsMap["verification"]): RenderedEmail {
  const { url, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const html = `<p>${s.body}</p>
<p><a href="${url}">${escapeHtml(url)}</a></p>
<p>${s.footer}</p>`;

  return { subject: s.subject, html };
}
