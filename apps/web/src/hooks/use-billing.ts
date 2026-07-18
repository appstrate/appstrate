// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { ApiError } from "../api/errors";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "../stores/app-store";
import { useCurrentOrgId } from "./use-org";
import { billingKeys } from "../lib/query-keys";

/**
 * The `/api/billing/*` routes are contributed at runtime by the private
 * cloud module — they are deliberately ABSENT from the OSS OpenAPI spec
 * (Apache-2.0 core carries no billing vocabulary), so the typed client
 * cannot express them. This file-local fetch mirrors the typed client's
 * middleware (org/app headers, credentials, RFC 9457 → ApiError) and is the
 * single sanctioned untyped call site in the SPA.
 */
async function cloudApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const applicationId = getCurrentApplicationId();
  if (applicationId) headers["X-Application-Id"] = applicationId;

  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: "include",
    headers: { ...headers, ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    if (body.code) {
      throw new ApiError(
        body.code,
        body.detail || `API Error: ${res.status}`,
        res.status,
        body.errors,
        body.requestId,
      );
    }
    throw new Error(body.detail || `API Error: ${res.status}`);
  }
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

export interface BillingPlan {
  id: string;
  name: string;
}

export interface BillingPlanDetail {
  id: string;
  name: string;
  price: number;
  credit_quota: number;
}

export interface BillingInfo {
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

export function getUsageBarColor(usagePercent: number): string {
  if (usagePercent >= 90) return "bg-destructive";
  if (usagePercent >= 70) return "bg-yellow-500";
  return "bg-primary";
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
