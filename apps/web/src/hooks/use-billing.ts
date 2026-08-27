// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { toApiError } from "../api/client";
import { buildScopingHeaders } from "../lib/scoping-headers";
import { useCurrentOrgId } from "./use-org";
import { billingKeys } from "../lib/query-keys";

/**
 * The `/api/billing/*` routes are contributed at runtime by the private
 * cloud module — they are deliberately ABSENT from the OSS OpenAPI spec
 * (Apache-2.0 core carries no billing vocabulary), so the typed client
 * cannot express them. This file-local fetch REUSES the typed client's
 * middleware pieces — `buildScopingHeaders` for the org/app wire contract and
 * `toApiError` for the RFC 9457 mapping — rather than restating them, and is
 * the single sanctioned untyped call site in the SPA.
 *
 * It used to restate both, and had already drifted: `toApiError` grew a sixth
 * argument (`param`, the field name a validation problem points at) and the
 * copy did not, so every billing error surfaced without field attribution and
 * nothing failed. `scoping-headers.ts` calls itself the single source of truth
 * for those header names; this was the one hand-rolled fetch not consuming it.
 */
async function cloudApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...buildScopingHeaders(),
      ...options.headers,
    },
  });
  if (!res.ok) throw await toApiError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

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

interface BillingPlan {
  id: string;
  name: string;
}

export interface BillingPlanDetail {
  id: string;
  name: string;
  price: number;
  credit_quota: number;
  /**
   * Durable-file storage the plan grants, in bytes — the value projected onto
   * the org's platform storage limit. `@appstrate/cloud` declares it `required`
   * on `CloudBillingPlan` and sets it on every plan definition, so one spelling
   * is read and no absent-field branch exists here.
   *
   * Required, and NOT separately validated at runtime. Nothing on this payload
   * is: `cloudApi` is a cast, so `credit_quota`, `usage_percent` and
   * `plan.id` are all trusted the same way. A guard for this one field was
   * tried and removed — throwing in the query fails the whole `useBilling`
   * call, and three of its four consumers (the sidebar credit meter, the
   * onboarding recap, the plan step) render nothing on error while not reading
   * this field at all. Taking those down over a storage number is a worse
   * failure than the one it replaced, and singling out one field of an
   * unvalidated payload buys nothing the type does not already state.
   */
  file_storage_bytes: number;
}

interface BillingInfo {
  plan: BillingPlan;
  plans: BillingPlanDetail[];
  usage_percent: number;
  credits_used: number;
  credit_quota: number;
  period_end: string | null;
  status:
    "active" | "trialing" | "past_due" | "unpaid" | "paused" | "canceling" | "canceled" | "none";
  upgrades: BillingPlanDetail[];
}

export function useBilling(options?: { enabled?: boolean }) {
  const orgId = useCurrentOrgId();
  const enabled = (options?.enabled ?? true) && !!orgId;
  return useQuery({
    queryKey: billingKeys.forOrg(orgId),
    queryFn: () => cloudApi<BillingInfo>("/billing"),
    enabled,
    staleTime: 60_000,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: async ({ planId, returnUrl }: { planId: string; returnUrl?: string }) => {
      const res = await cloudApi<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan_id: planId, ...(returnUrl && { return_url: returnUrl }) }),
      });
      return res.url;
    },
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: async () => {
      const res = await cloudApi<{ url: string }>("/billing/portal", {
        method: "POST",
      });
      return res.url;
    },
  });
}
