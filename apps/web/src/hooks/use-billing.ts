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

export function useCheckout() {
  return $api.useMutation("post", "/api/billing/checkout");
}

export function usePortal() {
  return $api.useMutation("post", "/api/billing/portal");
}
