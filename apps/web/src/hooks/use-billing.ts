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
   * Required rather than optional, and checked rather than trusted: the two
   * ship together (the cloud image is built `FROM` the platform image and
   * serves this SPA) but they are not one version — that `FROM` pairs a cloud
   * checkout of one age with a platform image of another. `assertPlansPriced`
   * below is where that gap fails loudly instead of rendering "undefined B".
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

/**
 * Refuse a payload whose plans are missing `file_storage_bytes`.
 *
 * `cloudApi` is a hand-rolled `fetch` + `JSON.parse` + cast: the interfaces
 * above are a compile-time contract with a producer in another repo, and
 * nothing enforces them at runtime. `file_storage_bytes` is required on
 * `CloudBillingPlan` and set on every plan `@appstrate/cloud` defines, so an
 * absent one means a cloud build older than the field — which the image
 * layering makes unlikely but not impossible, since a cloud checkout of one
 * age is built `FROM` a platform image of another.
 *
 * It has to be checked rather than trusted because the failure is silent
 * otherwise: `formatBytes(undefined)` returns the string `"undefined B"`, so
 * the card would price a plan at "undefined B de stockage" and nobody would
 * hear about it. `docs/NO_TRANSITIONAL_CODE.md` step 5 — a form that can still
 * arrive from outside must fail loudly, never work. React Query surfaces the
 * throw as the billing page's error state, naming the field and the producer.
 */
function assertPlansPriced(info: BillingInfo): BillingInfo {
  const unpriced = [...info.plans, ...info.upgrades].filter(
    (p) => typeof p.file_storage_bytes !== "number",
  );
  if (unpriced.length > 0) {
    throw new Error(
      `Billing payload is missing file_storage_bytes on ${unpriced.length} plan(s): ` +
        `${unpriced.map((p) => p.id).join(", ")}. The billing module predates the field — ` +
        `upgrade @appstrate/cloud to a build that sets it on every plan.`,
    );
  }
  return info;
}

export function useBilling(options?: { enabled?: boolean }) {
  const orgId = useCurrentOrgId();
  const enabled = (options?.enabled ?? true) && !!orgId;
  return useQuery({
    queryKey: billingKeys.forOrg(orgId),
    queryFn: () => cloudApi<BillingInfo>("/billing").then(assertPlansPriced),
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
