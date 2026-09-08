import type {
  BillingEmailType,
  BillingEmailRenderer,
  BillingEmailPropsMap,
  BillingEmailContext,
  RenderedEmail,
} from "./types.ts";
import { renderSubscriptionConfirmedEmail } from "./templates/subscription-confirmed.ts";
import { renderPaymentReceiptEmail } from "./templates/payment-receipt.ts";
import { renderPaymentFailedEmail } from "./templates/payment-failed.ts";
import { renderCancellationConfirmedEmail } from "./templates/cancellation-confirmed.ts";
import { renderSubscriptionExpiredEmail } from "./templates/subscription-expired.ts";
import { renderPlanChangedEmail } from "./templates/plan-changed.ts";
import { renderQuotaWarningEmail } from "./templates/quota-warning.ts";
import { renderRenewalReminderEmail } from "./templates/renewal-reminder.ts";
import { renderCardExpiringEmail } from "./templates/card-expiring.ts";

const renderers: { [K in BillingEmailType]: BillingEmailRenderer<K> } = {
  "subscription-confirmed": renderSubscriptionConfirmedEmail,
  "payment-receipt": renderPaymentReceiptEmail,
  "payment-failed": renderPaymentFailedEmail,
  "cancellation-confirmed": renderCancellationConfirmedEmail,
  "subscription-expired": renderSubscriptionExpiredEmail,
  "plan-changed": renderPlanChangedEmail,
  "quota-warning": renderQuotaWarningEmail,
  "renewal-reminder": renderRenewalReminderEmail,
  "card-expiring": renderCardExpiringEmail,
};

export function renderBillingEmail<T extends BillingEmailType>(
  type: T,
  props: BillingEmailPropsMap[T],
  context?: BillingEmailContext,
): RenderedEmail {
  const renderer = renderers[type] as BillingEmailRenderer<T>;
  const rendered = renderer(props, context);

  // Subject suffix is applied centrally so every billing email is
  // distinguishable in the inbox of a user belonging to several orgs.
  // Header-injection guard: subjects must stay single-line.
  const orgName = context?.orgName?.trim();
  if (!orgName) return rendered;
  return {
    subject: `${rendered.subject} — ${orgName}`.replace(/[\r\n]/g, " "),
    html: rendered.html,
  };
}
