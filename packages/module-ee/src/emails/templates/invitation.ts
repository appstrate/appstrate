// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { InvitationProps, RenderedEmail } from "../types.ts";
import { wrapEeLayout, ctaButton, escapeHtml } from "../layout.ts";

const strings = {
  fr: {
    subject: "Invitation à rejoindre {orgName} sur Appstrate",
    heading: "Vous êtes invité",
    body: '{inviterName} vous invite à rejoindre <strong style="color:#1a1a1a;">{orgName}</strong> en tant que <strong style="color:#1a1a1a;">{role}</strong>.',
    button: "Accepter l'invitation",
    fallback: "Ou copiez ce lien dans votre navigateur :",
    footer: "Ce lien expire dans 7 jours.",
  },
  en: {
    subject: "Invitation to join {orgName} on Appstrate",
    heading: "You are invited",
    body: '{inviterName} invites you to join <strong style="color:#1a1a1a;">{orgName}</strong> as <strong style="color:#1a1a1a;">{role}</strong>.',
    button: "Accept the invitation",
    fallback: "Or copy this link into your browser:",
    footer: "This link expires in 7 days.",
  },
} as const;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function renderEeInvitationEmail(props: InvitationProps): RenderedEmail {
  const { inviteUrl, orgName, inviterName, role, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const safeOrgName = escapeHtml(orgName);
  const safeInviterName = escapeHtml(inviterName);
  const safeRole = escapeHtml(role);
  const vars = { orgName: safeOrgName, inviterName: safeInviterName, role: safeRole };

  const subject = interpolate(s.subject, { orgName }).replace(/[\r\n]/g, "");

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
${ctaButton(s.button, inviteUrl)}
<p style="margin:0 0 4px;font-size:13px;color:#737373;">${s.fallback}</p>
<p style="margin:0;font-size:13px;word-break:break-all;"><a href="${inviteUrl}" style="color:#6d28d9;">${escapeHtml(inviteUrl)}</a></p>`;

  return {
    subject,
    html: wrapEeLayout({ locale, content, footer: s.footer }),
  };
}
