// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { CardExpiringProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { ctaButton, escapeHtml, interpolate, wrapEeLayout } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre carte bancaire expire bientot",
    heading: "Carte bancaire bientot expiree",
    body: 'La carte se terminant par <strong style="color:#1a1a1a;">**** {cardLast4}</strong> (exp. <strong style="color:#1a1a1a;">{expiryMonth}</strong>) va bientot expirer.',
    details:
      "Pour eviter une interruption de votre abonnement, mettez a jour votre moyen de paiement.",
    button: "Mettre a jour la carte",
    footer: "Cet email est envoye 30 jours avant l'expiration de votre carte.",
  },
  en: {
    subject: "Your payment card is expiring soon",
    heading: "Payment card expiring soon",
    body: 'The card ending in <strong style="color:#1a1a1a;">**** {cardLast4}</strong> (exp. <strong style="color:#1a1a1a;">{expiryMonth}</strong>) is expiring soon.',
    details: "To avoid any interruption to your subscription, please update your payment method.",
    button: "Update card",
    footer: "This email is sent 30 days before your card expires.",
  },
} as const;

export function renderCardExpiringEmail(
  props: CardExpiringProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { cardLast4, expiryMonth, updateUrl, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    cardLast4: escapeHtml(cardLast4),
    expiryMonth: escapeHtml(expiryMonth),
  };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.details}</p>
${ctaButton(s.button, updateUrl)}`;

  return {
    subject: s.subject,
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
