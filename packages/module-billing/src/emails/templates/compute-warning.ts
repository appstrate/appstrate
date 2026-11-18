// SPDX-License-Identifier: Apache-2.0

import type { ComputeWarningProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { ctaButton, formatDate, interpolate, wrapBillingLayout } from "../layout.ts";

const strings = {
  fr: {
    subject: "Vous avez utilisé {usagePercent} % de vos minutes de calcul",
    heading: "Minutes de calcul bientôt épuisées",
    body: 'Vous avez utilisé <strong style="color:#1a1a1a;">{minutesUsed}</strong> minutes sur <strong style="color:#1a1a1a;">{minutesIncluded}</strong> incluses dans votre plan <strong style="color:#1a1a1a;">{planName}</strong> ce mois-ci (<strong style="color:#1a1a1a;">{usagePercent} %</strong>).',
    details:
      "Une fois les minutes épuisées, vous ne pourrez plus lancer d'exécution avant le {resetDate}. Les exécutions déjà lancées vont à leur terme.",
    button: "Passer en Équipe",
    footer: "Cet e-mail est envoyé automatiquement lorsque votre consommation dépasse 80 %.",
  },
  en: {
    subject: "You've used {usagePercent}% of your compute minutes",
    heading: "Compute minutes almost used up",
    body: 'You\'ve used <strong style="color:#1a1a1a;">{minutesUsed}</strong> of the <strong style="color:#1a1a1a;">{minutesIncluded}</strong> minutes included in your <strong style="color:#1a1a1a;">{planName}</strong> plan this month (<strong style="color:#1a1a1a;">{usagePercent}%</strong>).',
    details:
      "Once the minutes run out, you won't be able to start a run until {resetDate}. Runs already started will finish.",
    button: "Upgrade to Team",
    footer: "This email is sent automatically when your usage exceeds 80%.",
  },
} as const;

export function renderComputeWarningEmail(
  props: ComputeWarningProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, usagePercent, minutesUsed, minutesIncluded, resetDate, upgradeUrl, locale } =
    props;
  const s = strings[locale] ?? strings.fr;
  const numberLocale = locale === "fr" ? "fr-FR" : "en-US";

  const vars = {
    planName,
    usagePercent: String(usagePercent),
    minutesUsed: minutesUsed.toLocaleString(numberLocale),
    minutesIncluded: minutesIncluded.toLocaleString(numberLocale),
    resetDate: formatDate(resetDate, locale),
  };

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.body, vars)}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(s.details, vars)}</p>
${ctaButton(s.button, upgradeUrl)}`;

  return {
    subject: interpolate(s.subject, vars).replace(/[\r\n]/g, ""),
    html: wrapBillingLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
