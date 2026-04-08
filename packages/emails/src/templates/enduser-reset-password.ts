// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: (appName: string) => `Réinitialisez votre mot de passe — ${appName}`,
    body: "Cliquez sur le lien ci-dessous pour réinitialiser votre mot de passe :",
    footer: "Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.",
  },
  en: {
    subject: (appName: string) => `Reset your password — ${appName}`,
    body: "Click the link below to reset your password:",
    footer: "If you did not request this reset, ignore this email.",
  },
};

export function renderEndUserResetPasswordEmail(
  props: EmailPropsMap["enduser-reset-password"],
): RenderedEmail {
  const s = strings[props.locale] ?? strings.fr;
  const appName = props.branding.name ?? "Appstrate";

  const html = `<p>${s.body}</p>
<p><a href="${escapeHtml(props.url)}">${escapeHtml(props.url)}</a></p>
<p>${s.footer}</p>`;

  return { subject: s.subject(appName), html };
}
