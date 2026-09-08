// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Local type definitions matching @appstrate/emails contracts.
 * EE doesn't depend on @appstrate/emails — these types mirror the
 * EmailRenderer/EmailPropsMap shapes so EE templates are self-contained.
 */

import type { OrgRole } from "../types.ts";

export type SupportedLocale = "fr" | "en";

export interface RenderedEmail {
  subject: string;
  html: string;
}

// ---------------------------------------------------------------------------
// OSS email override types (verification + invitation)
// ---------------------------------------------------------------------------

export interface VerificationProps {
  user: { name: string; email: string };
  url: string;
  locale: SupportedLocale;
}

export interface InvitationProps {
  email: string;
  inviteUrl: string;
  orgName: string;
  inviterName: string;
  role: OrgRole;
  locale: SupportedLocale;
}

export interface MagicLinkProps {
  email: string;
  url: string;
  locale: SupportedLocale;
}

export interface ResetPasswordProps {
  email: string;
  url: string;
  locale: SupportedLocale;
}

// ---------------------------------------------------------------------------
// Billing email types (EE-only — not in @appstrate/emails)
// ---------------------------------------------------------------------------

export type BillingEmailType =
  | "subscription-confirmed"
  | "payment-receipt"
  | "payment-failed"
  | "cancellation-confirmed"
  | "subscription-expired"
  | "plan-changed"
  | "quota-warning"
  | "card-expiring";

export interface SubscriptionConfirmedProps {
  planName: string;
  price: number;
  periodEnd: string; // ISO date
  locale: SupportedLocale;
}

export interface PaymentReceiptProps {
  planName: string;
  amount: number; // dollars
  invoiceUrl: string | null;
  periodEnd: string; // ISO date
  locale: SupportedLocale;
}

export interface PaymentFailedProps {
  planName: string;
  amount: number;
  attemptNumber: number;
  updateUrl: string;
  locale: SupportedLocale;
}

export interface CancellationConfirmedProps {
  planName: string;
  accessUntil: string; // ISO date
  locale: SupportedLocale;
}

export interface SubscriptionExpiredProps {
  resubscribeUrl: string;
  locale: SupportedLocale;
}

export interface PlanChangedProps {
  oldPlanName: string;
  newPlanName: string;
  newPrice: number;
  effectiveDate: string; // ISO date
  locale: SupportedLocale;
}

export interface QuotaWarningProps {
  planName: string;
  usagePercent: number;
  creditsUsed: number;
  creditQuota: number;
  upgradeUrl: string;
  locale: SupportedLocale;
}

export interface CardExpiringProps {
  cardLast4: string;
  expiryMonth: string; // "MM/YY"
  updateUrl: string;
  locale: SupportedLocale;
}

export interface BillingEmailPropsMap {
  "subscription-confirmed": SubscriptionConfirmedProps;
  "payment-receipt": PaymentReceiptProps;
  "payment-failed": PaymentFailedProps;
  "cancellation-confirmed": CancellationConfirmedProps;
  "subscription-expired": SubscriptionExpiredProps;
  "plan-changed": PlanChangedProps;
  "quota-warning": QuotaWarningProps;
  "card-expiring": CardExpiringProps;
}

/**
 * Cross-cutting context shared by every billing email, resolved once at the
 * send site (never part of the per-template business props).
 */
export interface BillingEmailContext {
  /**
   * Display name of the organization the email concerns. Shown in the
   * subject suffix and the layout header. Null when unresolvable (org
   * deleted, resolver unavailable) — the email renders without it.
   */
  orgName?: string | null;
}

export type BillingEmailRenderer<T extends BillingEmailType> = (
  props: BillingEmailPropsMap[T],
  context?: BillingEmailContext,
) => RenderedEmail;
