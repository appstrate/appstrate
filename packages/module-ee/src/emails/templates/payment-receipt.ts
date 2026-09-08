// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { PaymentReceiptProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { wrapEeLayout, ctaButton, formatDate } from "../layout.ts";

const strings = {
  fr: {
    subject: "Re\u00e7u de paiement \u2014 {amount}\u00a0$",
    heading: "Paiement re\u00e7u",
    body: 'Nous avons bien re\u00e7u votre paiement de <strong style="color:#1a1a1a;">{amount}\u00a0$</strong> pour le plan <strong style="color:#1a1a1a;">{planName}</strong>.',
    details: 'Prochaine facturation le <strong style="color:#1a1a1a;">{periodEnd}</strong>.',
    button: "Voir la facture",
    noInvoice: "La facture sera disponible dans votre portail de facturation.",
    footer: "Ce re\u00e7u confirme le paiement de votre abonnement Appstrate.",
  },
  en: {
    subject: "Payment receipt \u2014 ${amount}",
    heading: "Payment received",
    body: 'We received your payment of <strong style="color:#1a1a1a;">${amount}</strong> for the <strong style="color:#1a1a1a;">{planName}</strong> plan.',
    details: 'Next billing date: <strong style="color:#1a1a1a;">{periodEnd}</strong>.',
    button: "View invoice",
    noInvoice: "The invoice will be available in your billing portal.",
    footer: "This receipt confirms payment for your Appstrate subscription.",
  },
} as const;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

export function renderPaymentReceiptEmail(
  props: PaymentReceiptProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, amount, invoiceUrl, periodEnd, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    planName,
    amount: amount.toFixed(2),
    periodEnd: formatDate(periodEnd, locale),
  };

  const invoiceSection = invoiceUrl
    ? ctaButton(s.button, invoiceUrl)
    : `<p style="margin:16px 0 0;font-size:13px;color:#737373;">${s.noInvoice}</p>`;

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.details, vars)}</p>
${invoiceSection}`;

  return {
    subject: interpolate(s.subject, vars).replace(/[\r\n]/g, ""),
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
