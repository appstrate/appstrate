// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: (appName: string) => `Vérifiez votre adresse email — ${appName}`,
    body: "Cliquez sur le lien ci-dessous pour vérifier votre adresse email :",
    footer: "Si vous n'avez pas créé de compte, ignorez cet email.",
  },
  en: {
    subject: (appName: string) => `Verify your email address — ${appName}`,
    body: "Click the link below to verify your email address:",
    footer: "If you did not create an account, ignore this email.",
  },
};

export function renderEndUserVerificationEmail(
  props: EmailPropsMap["enduser-verification"],
): RenderedEmail {
  const s = strings[props.locale] ?? strings.fr;
  const appName = props.branding.name ?? "Appstrate";

  const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(props.url)}">${escapeHtml(props.url)}</a></p>
<p>${s.footer}</p>`;

  return { subject: s.subject(appName), html };
}
