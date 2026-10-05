// SPDX-License-Identifier: Apache-2.0

import { escapeHtml } from "@appstrate/core/html";
import type { EmailPropsMap, RenderedEmail, SupportedLocale } from "../types.ts";
import { linkValiditySentence } from "./simple-email.ts";

const strings = {
  fr: {
    subject: "Confirmez le changement de votre adresse email",
    body: "Un changement d'adresse email vers {newEmail} a été demandé pour votre compte. Cliquez sur le lien ci-dessous pour l'approuver ; un lien de vérification sera ensuite envoyé à la nouvelle adresse.",
    footer:
      "Si vous n'êtes pas à l'origine de cette demande, ne cliquez pas sur ce lien et changez votre mot de passe : votre adresse reste inchangée.",
  },
  en: {
    subject: "Confirm the change of your email address",
    body: "A change of email address to {newEmail} was requested for your account. Click the link below to approve it; a verification link will then be sent to the new address.",
    footer:
      "If you did not request this, do not click the link and change your password: your address stays unchanged.",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

export function renderEmailChangeConfirmationEmail(
  props: EmailPropsMap["email-change-confirmation"],
): RenderedEmail {
  const s = strings[props.locale] ?? strings.fr;
  // No emphasis markup: mail clients derive the text part from this HTML and
  // would wrap the address in asterisks.
  const body = s.body.replace("{newEmail}", escapeHtml(props.newEmail));

  const html = `<p>${body}</p>
<p><a href="${escapeHtml(props.url)}">${escapeHtml(props.url)}</a></p>
<p>${linkValiditySentence(props.expiresInMinutes, props.locale)}</p>
<p>${s.footer}</p>`;

  return { subject: s.subject, html };
}
