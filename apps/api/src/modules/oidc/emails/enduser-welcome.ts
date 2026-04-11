// SPDX-License-Identifier: Apache-2.0

/**
 * Welcome email sent to an end-user after their first successful OIDC
 * login against an Appstrate application.
 */

import { escapeHtml } from "../pages/html.ts";
import { renderEmailShell } from "./layout.ts";

export interface EndUserWelcomeProps {
  name: string;
  email: string;
  applicationName: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderEndUserWelcomeEmail(props: EndUserWelcomeProps): RenderedEmail {
  const safeName = escapeHtml(props.name);
  const safeApp = escapeHtml(props.applicationName);
  const subject = `Bienvenue sur ${props.applicationName}`;
  const bodyHtml = `
    <h1 style="font-size:20px;margin:0 0 16px;">Bienvenue, ${safeName}.</h1>
    <p style="margin:0 0 12px;color:#444;line-height:1.5;">
      Votre compte pour <strong>${safeApp}</strong> a été créé avec succès.
      Vous pouvez désormais autoriser cette application à accéder à vos agents
      et à votre historique Appstrate.
    </p>
    <p style="margin:0;color:#666;font-size:13px;">
      Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message —
      aucune action n'a été prise.
    </p>
  `;
  return { subject, html: renderEmailShell({ title: subject, bodyHtml }) };
}
