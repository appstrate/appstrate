import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

export interface BillingPlan {
  id: string;
  name: string;
}

export interface BillingUpgrade {
  id: string;
  name: string;
  price: number;
}

export interface BillingInfo {
  plan: BillingPlan;
  usagePercent: number;
  periodEnd: string | null;
  status: "active" | "trialing" | "past_due" | "unpaid" | "paused" | "canceling" | "canceled" | "none";
  upgrades: BillingUpgrade[];
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
    mutationFn: async (planId: string) => {
      const res = await api<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId }),
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
