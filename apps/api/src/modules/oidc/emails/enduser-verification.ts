// SPDX-License-Identifier: Apache-2.0

/**
 * Email verification link sent to a new end-user during signup.
 */

import { escapeHtml } from "../pages/html.ts";
import { renderEmailShell } from "./layout.ts";

export interface EndUserVerificationProps {
  name: string;
  email: string;
  applicationName: string;
  verifyUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderEndUserVerificationEmail(props: EndUserVerificationProps): RenderedEmail {
  const safeName = escapeHtml(props.name);
  const safeApp = escapeHtml(props.applicationName);
  const safeUrl = escapeHtml(props.verifyUrl);
  const subject = `Confirmez votre email pour ${props.applicationName}`;
  const bodyHtml = `
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${safeName},</h1>
    <p style="margin:0 0 16px;color:#444;line-height:1.5;">
      Pour terminer votre inscription à <strong>${safeApp}</strong>, confirmez
      votre adresse email en cliquant sur le bouton ci-dessous.
    </p>
    <p style="margin:24px 0;">
      <a
        href="${safeUrl}"
        style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500;"
      >Confirmer mon email</a>
    </p>
    <p style="margin:0 0 8px;color:#666;font-size:13px;">
      Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :
    </p>
    <p style="margin:0;color:#4f46e5;font-size:13px;word-break:break-all;">${safeUrl}</p>
    <p style="margin:24px 0 0;color:#999;font-size:12px;">
      Si vous n'avez pas demandé ce lien, ignorez ce message.
    </p>
  `;
  return { subject, html: renderEmailShell({ title: subject, bodyHtml }) };
}
