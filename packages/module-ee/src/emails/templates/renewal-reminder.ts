// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { RenewalReminderProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { wrapEeLayout, ctaButton, formatDate } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre abonnement sera renouvele le {renewalDate}",
    heading: "Renouvellement a venir",
    body: 'Votre abonnement <strong style="color:#1a1a1a;">{planName}</strong> sera automatiquement renouvele le <strong style="color:#1a1a1a;">{renewalDate}</strong> pour un montant de <strong style="color:#1a1a1a;">{amount}\u00a0$</strong>.',
    details:
      "Si vous souhaitez modifier ou annuler votre abonnement, vous pouvez le faire depuis votre portail de facturation.",
    button: "Gerer mon abonnement",
    footer: "Cet email est envoye 7 jours avant chaque renouvellement.",
  },
  en: {
    subject: "Your subscription renews on {renewalDate}",
    heading: "Upcoming renewal",
    body: 'Your <strong style="color:#1a1a1a;">{planName}</strong> subscription will automatically renew on <strong style="color:#1a1a1a;">{renewalDate}</strong> for <strong style="color:#1a1a1a;">${amount}</strong>.',
    details:
      "If you'd like to change or cancel your subscription, you can do so from your billing portal.",
    button: "Manage my subscription",
    footer: "This email is sent 7 days before each renewal.",
  },
} as const;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function renderRenewalReminderEmail(
  props: RenewalReminderProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, amount, renewalDate, portalUrl, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    planName,
    amount: amount.toFixed(2),
    renewalDate: formatDate(renewalDate, locale),
  };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.details}</p>
${ctaButton(s.button, portalUrl)}`;

  return {
    subject: interpolate(s.subject, vars).replace(/[\r\n]/g, ""),
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
