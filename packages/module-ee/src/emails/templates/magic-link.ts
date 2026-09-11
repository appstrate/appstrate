// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { EmailPropsMap, RenderedEmail } from "@appstrate/emails";
import { wrapEeLayout, ctaButton, escapeHtml } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre lien de connexion",
    heading: "Connexion",
    body: "Cliquez sur le bouton ci-dessous pour vous connecter à votre compte.",
    button: "Se connecter",
    fallback: "Ou copiez ce lien dans votre navigateur :",
    footer: "Si vous n'avez pas demandé ce lien, vous pouvez ignorer cet email.",
  },
  en: {
    subject: "Your sign-in link",
    heading: "Sign in",
    body: "Click the button below to sign in to your account.",
    button: "Sign in",
    fallback: "Or copy this link into your browser:",
    footer: "If you didn't request this link, you can safely ignore this email.",
  },
} as const;

export function renderEeMagicLinkEmail(props: EmailPropsMap["magic-link"]): RenderedEmail {
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
