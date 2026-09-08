import type { PaymentFailedProps, RenderedEmail, BillingEmailContext } from "../types.ts";
import { wrapCloudLayout, ctaButton } from "../layout.ts";

const strings = {
  fr: {
    subject: "Echec de paiement pour votre abonnement Appstrate",
    heading: {
      1: "Votre paiement n'a pas abouti",
      2: "Deuxieme tentative de paiement echouee",
      3: "Derniere tentative de paiement",
    } as Record<number, string>,
    body: {
      1: 'Nous n\'avons pas pu traiter le paiement de <strong style="color:#1a1a1a;">{amount}\u00a0$</strong> pour votre plan <strong style="color:#1a1a1a;">{planName}</strong>. Cela arrive souvent avec une carte expiree ou un plafond atteint.',
      2: 'Nous avons tente une deuxieme fois de prelever <strong style="color:#1a1a1a;">{amount}\u00a0$</strong> pour votre plan <strong style="color:#1a1a1a;">{planName}</strong>, sans succes. Votre service reste actif pour le moment.',
      3: 'C\'est notre derniere tentative pour prelever <strong style="color:#1a1a1a;">{amount}\u00a0$</strong>. Sans mise a jour de votre moyen de paiement, votre abonnement <strong style="color:#1a1a1a;">{planName}</strong> sera suspendu.',
    } as Record<number, string>,
    card: "Carte concernee : **** {cardLast4}",
    button: "Mettre a jour le paiement",
    footer: "Si vous avez des questions, contactez notre support.",
  },
  en: {
    subject: "Payment failed for your Appstrate subscription",
    heading: {
      1: "Your payment didn't go through",
      2: "Second payment attempt failed",
      3: "Final payment attempt",
    } as Record<number, string>,
    body: {
      1: 'We couldn\'t process the <strong style="color:#1a1a1a;">${amount}</strong> payment for your <strong style="color:#1a1a1a;">{planName}</strong> plan. This often happens with an expired card or insufficient funds.',
      2: 'We tried a second time to charge <strong style="color:#1a1a1a;">${amount}</strong> for your <strong style="color:#1a1a1a;">{planName}</strong> plan without success. Your service remains active for now.',
      3: 'This is our final attempt to charge <strong style="color:#1a1a1a;">${amount}</strong>. Without a payment update, your <strong style="color:#1a1a1a;">{planName}</strong> subscription will be suspended.',
    } as Record<number, string>,
    card: "Card on file: **** {cardLast4}",
    button: "Update payment method",
    footer: "If you have any questions, contact our support team.",
  },
} as const;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function clampAttempt(n: number): 1 | 2 | 3 {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

export function renderPaymentFailedEmail(
  props: PaymentFailedProps,
  context?: BillingEmailContext,
): RenderedEmail {
  const { planName, amount, cardLast4, attemptNumber, updateUrl, locale } = props;
  const s = strings[locale] ?? strings.fr;
  const attempt = clampAttempt(attemptNumber);

  const vars = {
    planName,
    amount: amount.toFixed(2),
    cardLast4: cardLast4 ?? "????",
  };

  const heading = s.heading[attempt] ?? s.heading[1]!;
  const body = s.body[attempt] ?? s.body[1]!;

  const cardLine = cardLast4
    ? `<p style="margin:16px 0 0;font-size:13px;color:#737373;">${interpolate(s.card, vars)}</p>`
    : "";

  const content = `
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a1a;">${heading}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#525252;">${interpolate(body, vars)}</p>
${cardLine}
${ctaButton(s.button, updateUrl)}`;

  return {
    subject: s.subject,
    html: wrapCloudLayout({ locale, content, footer: s.footer, orgName: context?.orgName }),
  };
}
