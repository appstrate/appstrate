import type { SubscriptionExpiredProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { wrapCloudLayout, ctaButton } from "../layout.ts";

const strings = {
  fr: {
    subject: "Votre abonnement Appstrate a expire",
    heading: "Abonnement expire",
    body: "Votre abonnement est termine. Votre compte a ete bascule sur le plan Free avec 0 credit disponible.",
    details: "Pour continuer a executer vos agents, reabonnez-vous a un plan payant.",
    button: "Se reabonner",
    footer:
      "Vos agents et configurations sont conserves \u2014 ils seront disponibles des que vous vous reabonnerez.",
  },
  en: {
    subject: "Your Appstrate subscription has expired",
    heading: "Subscription expired",
    body: "Your subscription has ended. Your account has been switched to the Free plan with 0 available credits.",
    details: "To continue running your agents, resubscribe to a paid plan.",
    button: "Resubscribe",
    footer:
      "Your agents and configurations are preserved \u2014 they will be available as soon as you resubscribe.",
  },
} as const;

export function renderSubscriptionExpiredEmail(
  props: SubscriptionExpiredProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { resubscribeUrl, locale } = props;
  const s = strings[locale] ?? strings.fr;

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${s.heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.body}</p>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${s.details}</p>
${ctaButton(s.button, resubscribeUrl)}`;

  return {
    subject: s.subject,
    html: wrapCloudLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
