// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { QuotaWarningProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { ctaButton, interpolate, wrapEeLayout } from "../layout.ts";

const strings = {
  fr: {
    subject: "Vous avez utilise {usagePercent}\u00a0% de vos credits",
    heading: "Quota de credits bientot atteint",
    body: 'Vous avez utilise <strong style="color:#1a1a1a;">{creditsUsed}</strong> credits sur <strong style="color:#1a1a1a;">{creditQuota}</strong> disponibles pour votre plan <strong style="color:#1a1a1a;">{planName}</strong> (<strong style="color:#1a1a1a;">{usagePercent}\u00a0%</strong>).',
    details:
      "Une fois votre quota atteint, vous ne pourrez plus executer d'agents jusqu'au prochain renouvellement.",
    button: "Upgrader mon plan",
    footer: "Cet email est envoye automatiquement lorsque votre consommation depasse 80\u00a0%.",
  },
  en: {
    subject: "You've used {usagePercent}% of your credits",
    heading: "Credit quota almost reached",
    body: 'You\'ve used <strong style="color:#1a1a1a;">{creditsUsed}</strong> of <strong style="color:#1a1a1a;">{creditQuota}</strong> credits available on your <strong style="color:#1a1a1a;">{planName}</strong> plan (<strong style="color:#1a1a1a;">{usagePercent}%</strong>).',
    details: "Once your quota is reached, you won't be able to run agents until the next renewal.",
    button: "Upgrade my plan",
    footer: "This email is sent automatically when your usage exceeds 80%.",
  },
} as const;

export function renderQuotaWarningEmail(
  props: QuotaWarningProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, usagePercent, creditsUsed, creditQuota, upgradeUrl, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const vars = {
    planName,
    usagePercent: String(usagePercent),
    creditsUsed: creditsUsed.toLocaleString(locale === "fr" ? "fr-FR" : "en-US"),
    creditQuota: creditQuota.toLocaleString(locale === "fr" ? "fr-FR" : "en-US"),
  };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.details}</p>
${ctaButton(s.button, upgradeUrl)}`;

  return {
    subject: interpolate(s.subject, vars).replace(/[\r\n]/g, ""),
    html: wrapEeLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
