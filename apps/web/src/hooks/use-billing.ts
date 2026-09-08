// SPDX-License-Identifier: Apache-2.0

/**
 * Billing hooks, backed by the `/api/billing*` routes `@appstrate/module-ee`
 * contributes to the platform OpenAPI spec. They are absent from a build that
 * does not load the module, which is what `features.billing` gates on — the
 * types are always there, the routes are not.
 */

import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";

/** One plan of the catalog: price, credit quota, and storage entitlement. */
export type BillingPlanDetail = components["schemas"]["EeBillingPlan"];

// Keyed on the catalog ids the spec enumerates, not on `string`: a plan added
// to `EeBillingPlan.id` without an icon or a description key fails to compile
// here instead of rendering a generic card at runtime.
export const PLAN_ICONS: Record<BillingPlanDetail["id"], LucideIcon> = {
  free: Sparkles,
  starter: Zap,
  pro: Crown,
};

/** i18n key suffix for each plan description */
export const PLAN_DESCRIPTION_KEYS: Record<BillingPlanDetail["id"], string> = {
  free: "onboarding.planFreeDescription",
  starter: "onboarding.planStarterDescription",
  pro: "onboarding.planProDescription",
};

/**
 * A plan id `POST /api/billing/checkout` accepts — a strict subset of the
 * catalog's, because `free` has no Stripe price. The same component backs the
 * request body and `upgrades[].id`, so the two cannot drift.
 */
export type CheckoutPlanId = components["schemas"]["EeCheckoutPlanId"];

export function useBilling(options?: { enabled?: boolean }) {
  const { enabled, header } = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/billing",
    { params: { header } },
    { enabled: (options?.enabled ?? true) && enabled, staleTime: 60_000 },
  );
}

/**
 * Exact key of {@link useBilling} — what a plan change invalidates so the plan,
 * quota and status the page shows come back from the server rather than from a
 * guess made in the browser.
 */
export function useBillingKey() {
  const { header } = useOrgOnlyScope();
  return $api.queryOptions("get", "/api/billing", { params: { header } }).queryKey;
}

/** The effective billing status of an org, as the spec enumerates it. */
export type BillingStatus = components["schemas"]["EeBillingAccount"]["status"];

/**
 * Statuses at which Stripe still holds a subscription this org can be MOVED
 * between plans — the client half of the module's `LIVE_SUBSCRIPTION_STATUSES`,
 * and it has to agree with it or every click lands on a 409.
 *
 * `canceling` is the projection of `cancel_at_period_end` over a subscription
 * that is otherwise active, trialing or past due, so it belongs here. `unpaid`,
 * `paused` and `canceled` do not: Stripe has stopped collecting on them, and the
 * server treats a new checkout as the way back.
 */
const CHANGEABLE_STATUSES: ReadonlySet<BillingStatus> = new Set<BillingStatus>([
  "active",
  "trialing",
  "past_due",
  "canceling",
]);

/**
 * Which route a plan selection goes to.
 *
 * An org that already has a live subscription CHANGES it in place. Stripe
 * Checkout only ever creates, so sending an upgrade there leaves the first
 * subscription running beside the second and bills the customer twice — the
 * server refuses that outright (`409 subscription_exists`), and this keeps the
 * dashboard from asking for it.
 */
export function planSelectionRoute(status: BillingStatus): "checkout" | "plan-change" {
  return CHANGEABLE_STATUSES.has(status) ? "plan-change" : "checkout";
}

export function useCheckout() {
  return $api.useMutation("post", "/api/billing/checkout");
}

/** Move the existing subscription onto another plan, with proration. */
export function useChangePlan() {
  return $api.useMutation("post", "/api/billing/plan");
}

export function usePortal() {
  return $api.useMutation("post", "/api/billing/portal");
}

/**
 * The two admin surfaces below are gated on `billing:manage` — the exact
 * permission `eeRequireAdmin()` checks — so a caller who can only READ billing
 * never fires a request the server would answer with 403.
 */

/** The org users granted `billing:*` without being owners or admins. */
export function useBillingManagers(options?: { enabled?: boolean }) {
  const { enabled, header } = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/billing/managers",
    { params: { header } },
    { enabled: (options?.enabled ?? true) && enabled },
  );
}

/**
 * Exact key of {@link useBillingManagers} — the entry a save writes its own
 * answer into before invalidating, so the list never blinks back to the stale
 * value between the response and the refetch.
 */
export function useBillingManagersKey() {
  const { header } = useOrgOnlyScope();
  return $api.queryOptions("get", "/api/billing/managers", { params: { header } }).queryKey;
}

/** Replace the whole manager set — the route is a `PUT` of the complete list. */
export function useReplaceBillingManagers() {
  return $api.useMutation("put", "/api/billing/managers");
}

/** Where invoices, receipts and payment alerts go. */
export function useBillingContact(options?: { enabled?: boolean }) {
  const { enabled, header } = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/billing/contact",
    { params: { header } },
    { enabled: (options?.enabled ?? true) && enabled },
  );
}

/** Exact key of {@link useBillingContact}, for the same reason. */
export function useBillingContactKey() {
  const { header } = useOrgOnlyScope();
  return $api.queryOptions("get", "/api/billing/contact", { params: { header } }).queryKey;
}

/** Merge-patch the contact; `billing_email: null` clears it. */
export function useUpdateBillingContact() {
  return $api.useMutation("patch", "/api/billing/contact");
}
