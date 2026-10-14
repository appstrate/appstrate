// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle, CreditCard } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { usePermissions } from "../../hooks/use-permissions";
import type { components } from "../../api/client";
import {
  useBilling,
  useBillingKey,
  useChangePlan,
  useCheckout,
  usePortal,
  type CheckoutPlanId,
} from "../../hooks/use-billing";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { UsageBar } from "../../components/usage-bar";
import { PlanGrid } from "../../components/plan-card";
import { BillingManagersSection } from "../../components/billing-managers-section";
import { BillingContactSection } from "../../components/billing-contact-section";
import { ErrorState, EmptyState } from "../../components/page-states";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { formatDateField } from "../../lib/format-date";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// Keyed on the status enum the spec declares, not on `string`: a status added
// to `EeBillingAccount.status` without an i18n key fails to compile here
// instead of rendering the raw key.
const STATUS_I18N: Record<components["schemas"]["EeBillingAccount"]["status"], string> = {
  past_due: "billing.statusPastDue",
  unpaid: "billing.statusUnpaid",
  paused: "billing.statusPaused",
  incomplete: "billing.statusIncomplete",
  canceling: "billing.statusCanceling",
  canceled: "billing.statusCanceled",
  active: "billing.statusActive",
  trialing: "billing.statusTrialing",
  none: "billing.noSubscription",
};

export function OrgSettingsBillingPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  // The route opens on `billing:read` under the `billing` feature
  // (`lib/route-access.ts`), both only `@appstrate/module-ee` contributes, so
  // `/api/billing` answers.
  const { data: billing, isLoading, error } = useBilling();
  const checkoutMutation = useCheckout();
  const changePlanMutation = useChangePlan();
  const portalMutation = usePortal();
  const queryClient = useQueryClient();
  const billingKey = useBillingKey();

  // Storage entitlement — core data (organizations.files_bytes_*), shown
  // next to the credit gauge because the plan drives the storage limit when
  // billing is on. Same source (useOrgStorage) as org-settings/general.
  const {
    storage,
    limitBytes: storageLimit,
    percent: storagePercent,
    usageLabel,
  } = useOrgStorage();

  // The two admin sections below are MOUNTED on `billing:manage`, not merely
  // hidden by it, so their queries never fire for a caller the routes would 403.
  const canManageBilling = can("billing:manage");

  if (isLoading) return <SettingsSkeleton rows={4} />;
  if (error) return <ErrorState error={error} />;
  if (!billing) {
    return <EmptyState message={t("billing.noAccount")} icon={CreditCard} compact />;
  }

  const statusLabel =
    billing.status === "canceling" && billing.period_end
      ? t("billing.statusCanceling", { date: formatDateField(billing.period_end, "date") })
      : billing.status === "active" && billing.period_end
        ? t("billing.cycleReset", { date: formatDateField(billing.period_end, "date") })
        : t(STATUS_I18N[billing.status] ?? "billing.noSubscription");

  const hasSubscription = billing.status !== "none";
  const upgradeIds = billing.upgrades.map((u) => u.id);
  // Every upgrade is a checkout target by type, so the header button just
  // offers the first one.
  const firstUpgradeId = upgradeIds[0];

  const handleManage = () => {
    portalMutation.mutate(
      {},
      {
        onSuccess: ({ url }) => {
          window.location.href = url;
        },
      },
    );
  };

  /**
   * The server reports the door as `plan_action`; the page follows it instead of
   * re-deriving it (a second Checkout beside a live subscription bills twice).
   * The plan lands through the Stripe webhook, so the page refetches.
   */
  const handleSelectPlan = (planId: CheckoutPlanId) => {
    switch (billing.plan_action) {
      case "portal":
        handleManage();
        return;
      case "plan-change":
        changePlanMutation.mutate(
          { body: { plan_id: planId } },
          {
            onSuccess: () => {
              toast.success(t("billing.planChangeRequested"));
              void queryClient.invalidateQueries({ queryKey: billingKey });
            },
          },
        );
        return;
      case "checkout":
        checkoutMutation.mutate(
          { body: { plan_id: planId, return_url: "/org-settings/billing" } },
          {
            onSuccess: ({ url }) => {
              window.location.href = url;
            },
          },
        );
        return;
    }
  };

  return (
    <>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-[0.95rem] font-semibold">
              {t("billing.currentPlan")}: {billing.plan.name}
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">{statusLabel}</p>
          </div>
          {hasSubscription ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleManage}
              disabled={portalMutation.isPending}
            >
              {t("billing.manage")}
            </Button>
          ) : firstUpgradeId ? (
            <Button size="sm" onClick={() => handleSelectPlan(firstUpgradeId)}>
              {t("billing.upgrade")}
            </Button>
          ) : null}
        </div>

        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t("billing.usage")}</span>
            <span className="font-medium">
              {billing.usage_percent}%
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                (
                {t("billing.creditsCount", {
                  used: billing.credits_used,
                  quota: billing.credit_quota,
                })}
                )
              </span>
            </span>
          </div>
          <UsageBar percent={billing.usage_percent} label={t("billing.usage")} />
        </div>

        {storage && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("billing.storageUsage")}</span>
              <span className="font-medium">
                {storageLimit === null ? (
                  usageLabel
                ) : (
                  <>
                    {storagePercent}%
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      ({usageLabel})
                    </span>
                  </>
                )}
              </span>
            </div>
            {storageLimit !== null && (
              <UsageBar percent={storagePercent ?? 0} label={t("billing.storageUsage")} />
            )}
          </div>
        )}
      </div>

      {billing.status === "past_due" && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("billing.pastDueWarning")}</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {t("billing.pastDueDescription")}
          </AlertDescription>
        </Alert>
      )}

      {billing.status === "canceling" && billing.period_end && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle />
          <AlertTitle>
            {t("billing.cancelingWarning", { date: formatDateField(billing.period_end, "date") })}
          </AlertTitle>
        </Alert>
      )}

      {billing.plans.length > 0 && (
        <div className="border-border bg-card mb-4 rounded-lg border p-5">
          <h3 className="mb-3 text-[0.95rem] font-semibold">{t("billing.upgradePlans")}</h3>
          <PlanGrid
            plans={billing.plans}
            currentPlanId={billing.plan.id}
            upgrades={upgradeIds}
            disabled={checkoutMutation.isPending || changePlanMutation.isPending}
            onSelect={handleSelectPlan}
          />
        </div>
      )}

      {canManageBilling && (
        <>
          <BillingManagersSection />
          <BillingContactSection />
        </>
      )}
    </>
  );
}
