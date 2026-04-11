// SPDX-License-Identifier: Apache-2.0

/**
 * Password reset email for an end-user.
 */

import { escapeHtml } from "../pages/html.ts";
import { renderEmailShell, primaryButtonColor } from "./layout.ts";
import type { ResolvedAppBranding } from "../services/branding.ts";

export interface EndUserResetPasswordProps {
  name: string;
  email: string;
  applicationName: string;
  resetUrl: string;
  branding?: ResolvedAppBranding;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderEndUserResetPasswordEmail(props: EndUserResetPasswordProps): RenderedEmail {
  const safeName = escapeHtml(props.name);
  const safeApp = escapeHtml(props.branding?.name ?? props.applicationName);
  const safeUrl = escapeHtml(props.resetUrl);
  const displayName = props.branding?.name ?? props.applicationName;
  const subject = `Réinitialisation de votre mot de passe ${displayName}`;
  const buttonColor = primaryButtonColor(props.branding);
  const bodyHtml = `
    <h1 style="font-size:20px;margin:0 0 16px;">Bonjour ${safeName},</h1>
    <p style="margin:0 0 16px;color:#444;line-height:1.5;">
      Nous avons reçu une demande de réinitialisation du mot de passe associé à
      votre compte <strong>${safeApp}</strong>. Cliquez sur le bouton ci-dessous
      pour choisir un nouveau mot de passe. Ce lien expirera dans 1 heure.
    </p>
    <p style="margin:24px 0;">
      <a
        href="${safeUrl}"
        style="display:inline-block;padding:12px 20px;background:${buttonColor};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:500;"
      >Réinitialiser mon mot de passe</a>
    </p>
    <p style="margin:0 0 8px;color:#666;font-size:13px;">
      Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :
    </p>
    <p style="margin:0;color:${buttonColor};font-size:13px;word-break:break-all;">${safeUrl}</p>
    <p style="margin:24px 0 0;color:#999;font-size:12px;">
      Si vous n'avez pas demandé cette réinitialisation, ignorez ce message —
      votre mot de passe actuel reste valide.
    </p>
  `;
  return {
    subject,
    html: renderEmailShell({ title: subject, bodyHtml, branding: props.branding }),
  };
}
