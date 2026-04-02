// SPDX-License-Identifier: Apache-2.0

import type { EmailPropsMap, RenderedEmail, SupportedLocale } from "../types.ts";
import { escapeHtml } from "./layout.ts";

const strings = {
  fr: {
    subject: "Invitation à rejoindre {orgName}",
    body: "{inviterName} vous invite à rejoindre l'organisation {orgName} en tant que {role}.",
    cta: "Accepter l'invitation :",
    footer: "Ce lien expire dans 7 jours.",
  },
  en: {
    subject: "Invitation to join {orgName}",
    body: "{inviterName} invites you to join {orgName} as {role}.",
    cta: "Accept the invitation:",
    footer: "This link expires in 7 days.",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function renderInvitationEmail(props: EmailPropsMap["invitation"]): RenderedEmail {
  const { inviteUrl, orgName, inviterName, role, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    orgName: escapeHtml(orgName),
    inviterName: escapeHtml(inviterName),
    role: escapeHtml(role),
  };

  const subject = interpolate(s.subject, { orgName }).replace(/[\r\n]/g, "");

  const html = `<p>${interpolate(s.body, vars)}</p>
<p>${s.cta} <a href="${inviteUrl}">${escapeHtml(inviteUrl)}</a></p>
<p>${s.footer}</p>`;

  return { subject, html };
}
