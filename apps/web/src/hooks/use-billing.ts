// SPDX-License-Identifier: Apache-2.0

/** Billing hooks over the `/api/billing*` routes `@appstrate/module-ee` contributes: the types are always there, the routes only when the module loads (`features.billing`). */

import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

/** One plan of the catalog: price, credit quota, and storage entitlement. */
export type BillingPlanDetail = components["schemas"]["EeBillingPlan"];

// Keyed on the spec's plan ids so a new plan without an icon/description fails to compile.
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

/** A plan id `POST /api/billing/checkout` accepts: the catalog's minus `free` (no Stripe price). */
export type CheckoutPlanId = components["schemas"]["EeCheckoutPlanId"];

/**
 * `billing:read` is an org grant a `guest` lacks, and the sidebar mounts this everywhere.
 * Disabled, it reports no data: a cached answer outlives a narrowed grant.
 */
export function useBilling(options?: { enabled?: boolean }) {
  const { enabled, header } = useOrgOnlyScope();
  const { can } = usePermissions();
  const active = (options?.enabled ?? true) && enabled && can("billing:read");
  return $api.useQuery(
    "get",
    "/api/billing",
    { params: { header } },
    { enabled: active, staleTime: 60_000, select: (billing) => (active ? billing : undefined) },
  );
}

/** Exact key of {@link useBilling} — what a plan change invalidates. */
export function useBillingKey() {
  const { header } = useOrgOnlyScope();
  return $api.queryOptions("get", "/api/billing", { params: { header } }).queryKey;
}

export function useCheckout() {
  return $api.useMutation("post", "/api/billing/checkout");
}

export function useChangePlan() {
  return $api.useMutation("post", "/api/billing/plan");
}

export function usePortal() {
  return $api.useMutation("post", "/api/billing/portal");
}

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

/** Exact key of {@link useBillingManagers}: a save writes its answer there before invalidating, so the list never blinks back to stale. */
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
