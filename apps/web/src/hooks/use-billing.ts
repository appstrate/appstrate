// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation } from "@tanstack/react-query";
import { Sparkles, Zap, Crown, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

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
  creditQuota: number;
}

export interface BillingInfo {
  plan: BillingPlan;
  plans: BillingPlanDetail[];
  usagePercent: number;
  creditsUsed: number;
  creditQuota: number;
  periodEnd: string | null;
  status:
    | "active"
    | "trialing"
    | "past_due"
    | "unpaid"
    | "paused"
    | "canceling"
    | "canceled"
    | "none";
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
    queryKey: ["billing", orgId],
    queryFn: () => api<BillingInfo>("/billing"),
    enabled,
    staleTime: 60_000,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: async ({ planId, returnUrl }: { planId: string; returnUrl?: string }) => {
      const res = await api<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId, ...(returnUrl && { returnUrl }) }),
      });
      return res.url;
    },
  });
}

export function usePortal() {
  return useMutation({
    mutationFn: async () => {
      const res = await api<{ url: string }>("/billing/portal", {
        method: "POST",
      });
      return res.url;
    },
  });
}
