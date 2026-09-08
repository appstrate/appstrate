// SPDX-License-Identifier: Apache-2.0

/**
 * Billing hooks, backed by the `/api/billing*` routes `@appstrate/module-ee`
 * contributes to the platform OpenAPI spec. They are absent from a build that
 * does not load the module, which is what `features.billing` gates on — the
 * types are always there, the routes are not.
 */

import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { $api, type components, type paths } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";

export const PLAN_ICONS: Record<string, LucideIcon> = {
  free: Sparkles,
  starter: Zap,
  pro: Crown,
};

/** i18n key suffix for each plan description */
export const PLAN_DESCRIPTION_KEYS: Record<string, string> = {
  free: "onboarding.planFreeDescription",
  starter: "onboarding.planStarterDescription",
  pro: "onboarding.planProDescription",
};

/** One plan of the catalog: price, credit quota, and storage entitlement. */
export type BillingPlanDetail = components["schemas"]["EeBillingPlan"];

/**
 * The plan ids `POST /api/billing/checkout` accepts — a strict subset of the
 * catalog's, because `free` has no Stripe price. {@link isCheckoutPlanId} is
 * the single place the wider catalog id meets the narrower checkout id.
 */
export type CheckoutPlanId =
  paths["/api/billing/checkout"]["post"]["requestBody"]["content"]["application/json"]["plan_id"];

export function isCheckoutPlanId(id: BillingPlanDetail["id"]): id is CheckoutPlanId {
  return id !== "free";
}

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
