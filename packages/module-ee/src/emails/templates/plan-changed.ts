// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { PlanChangedProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { ctaButton, formatDate, interpolate, wrapEeLayout } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre plan a ete modifie",
    heading: "Changement de plan",
    body: 'Votre abonnement est passe de <strong style="color:#1a1a1a;">{oldPlanName}</strong> a <strong style="color:#1a1a1a;">{newPlanName}</strong> (<strong style="color:#1a1a1a;">{newPrice}\u00a0$/mois</strong>).',
    details:
      'Ce changement prend effet le <strong style="color:#1a1a1a;">{effectiveDate}</strong>. Vos nouveaux credits seront disponibles a la prochaine facturation.',
    button: "Voir mon abonnement",
    footer: "Vous pouvez gerer votre plan a tout moment depuis les parametres de facturation.",
  },
  en: {
    subject: "Your plan has been changed",
    heading: "Plan change",
    body: 'Your subscription has been changed from <strong style="color:#1a1a1a;">{oldPlanName}</strong> to <strong style="color:#1a1a1a;">{newPlanName}</strong> (<strong style="color:#1a1a1a;">${newPrice}/month</strong>).',
    details:
      'This change takes effect on <strong style="color:#1a1a1a;">{effectiveDate}</strong>. Your new credits will be available at the next billing date.',
    button: "View my subscription",
    footer: "You can manage your plan at any time from the billing settings.",
  },
} as const;

export function renderPlanChangedEmail(
  props: PlanChangedProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { oldPlanName, newPlanName, newPrice, effectiveDate, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    oldPlanName,
    newPlanName,
    newPrice: String(newPrice),
    effectiveDate: formatDate(effectiveDate, locale),
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
