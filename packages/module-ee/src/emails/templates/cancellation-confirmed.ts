// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { CancellationConfirmedProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { wrapEeLayout, formatDate } from "../layout.ts";

const strings = {
  fr: {
    subject: "Confirmation d'annulation de votre abonnement",
    heading: "Abonnement annule",
    body: 'Votre abonnement <strong style="color:#1a1a1a;">{planName}</strong> a ete annule. Vous conservez l\'acces a toutes les fonctionnalites jusqu\'au <strong style="color:#1a1a1a;">{accessUntil}</strong>.',
    details:
      "Apres cette date, votre compte basculera sur le plan Free. Vous pourrez vous reabonner a tout moment.",
    footer: "Merci d'avoir utilise Appstrate.",
  },
  en: {
    subject: "Subscription cancellation confirmed",
    heading: "Subscription cancelled",
    body: 'Your <strong style="color:#1a1a1a;">{planName}</strong> subscription has been cancelled. You retain access to all features until <strong style="color:#1a1a1a;">{accessUntil}</strong>.',
    details:
      "After that date, your account will switch to the Free plan. You can resubscribe at any time.",
    footer: "Thank you for using Appstrate.",
  },
} as const;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function renderCancellationConfirmedEmail(
  props: CancellationConfirmedProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, accessUntil, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = { planName, accessUntil: formatDate(accessUntil, locale) };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.details}</p>`;

  return {
    subject: s.subject,
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
