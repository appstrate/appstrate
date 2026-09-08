// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { SubscriptionConfirmedProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { ctaButton, formatDate, interpolate, wrapEeLayout } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre abonnement est actif",
    heading: "Bienvenue dans votre nouveau plan",
    body: 'Votre abonnement <strong style="color:#1a1a1a;">{planName}</strong> est maintenant actif au tarif de <strong style="color:#1a1a1a;">{price}\u00a0$/mois</strong>.',
    details: 'Prochaine facturation le <strong style="color:#1a1a1a;">{periodEnd}</strong>.',
    button: "Acceder au tableau de bord",
    footer:
      "Vous pouvez gerer votre abonnement a tout moment depuis les parametres de facturation.",
  },
  en: {
    subject: "Your subscription is active",
    heading: "Welcome to your new plan",
    body: 'Your <strong style="color:#1a1a1a;">{planName}</strong> subscription is now active at <strong style="color:#1a1a1a;">${price}/month</strong>.',
    details: 'Next billing date: <strong style="color:#1a1a1a;">{periodEnd}</strong>.',
    button: "Go to dashboard",
    footer: "You can manage your subscription at any time from the billing settings.",
  },
} as const;

export function renderSubscriptionConfirmedEmail(
  props: SubscriptionConfirmedProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, price, periodEnd, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    planName,
    price: String(price),
    periodEnd: formatDate(periodEnd, locale),
  };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.details, vars)}</p>
${ctaButton(s.button, "/")}`;

  return {
    subject: s.subject,
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
