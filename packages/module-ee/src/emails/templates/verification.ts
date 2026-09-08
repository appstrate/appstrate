// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { EmailPropsMap, RenderedEmail } from "@appstrate/emails";
import { wrapEeLayout, ctaButton, escapeHtml } from "../layout.ts";

const strings = {
  fr: {
    subject: "Vérifiez votre adresse email",
    heading: "Bienvenue sur Appstrate",
    body: "Cliquez sur le bouton ci-dessous pour vérifier votre adresse email et commencer à créer vos agents :",
    button: "Vérifier mon email",
    fallback: "Ou copiez ce lien dans votre navigateur :",
    footer: "Si vous n'avez pas créé de compte, ignorez cet email.",
  },
  en: {
    subject: "Verify your email address",
    heading: "Welcome to Appstrate",
    body: "Click the button below to verify your email address and start building your agents:",
    button: "Verify my email",
    fallback: "Or copy this link into your browser:",
    footer: "If you did not create an account, ignore this email.",
  },
} as const;

export function renderEeVerificationEmail(props: EmailPropsMap["verification"]): RenderedEmail {
  const { url, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.body}</p>
${ctaButton(s.button, url)}
<p style="margin:0 0 4px;font-size:13px;color:#737373;">${s.fallback}</p>
<p style="margin:0;font-size:13px;word-break:break-all;"><a href="${url}" style="color:#6d28d9;">${escapeHtml(url)}</a></p>`;

  return {
    subject: s.subject,
    html: wrapEeLayout({ locale, content, footer: s.footer }),
  };
}
