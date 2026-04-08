// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: (appName: string) => `Bienvenue sur ${appName}`,
    body: (name: string) => `Bonjour ${name}, votre compte a été vérifié avec succès.`,
    footer: "Vous pouvez maintenant vous connecter.",
  },
  en: {
    subject: (appName: string) => `Welcome to ${appName}`,
    body: (name: string) => `Hello ${name}, your account has been verified successfully.`,
    footer: "You can now sign in.",
  },
};

export function renderEndUserWelcomeEmail(props: EmailPropsMap["enduser-welcome"]): RenderedEmail {
  const s = strings[props.locale] ?? strings.fr;
  const appName = props.branding.name ?? "Appstrate";
  const name = escapeHtml(props.user.name || props.user.email);

  const html = `<p>${s.body(name)}</p>
<p>${s.footer}</p>`;

  return { subject: s.subject(appName), html };
}
