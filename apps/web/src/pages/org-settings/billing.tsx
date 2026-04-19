// SPDX-License-Identifier: Apache-2.0

import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppConfig } from "../../hooks/use-app-config";
import { useBilling, useCheckout, usePortal, getUsageBarColor } from "../../hooks/use-billing";
import { PlanGrid } from "../../components/plan-card";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { toast } from "sonner";

const STATUS_I18N: Record<string, string> = {
  past_due: "billing.statusPastDue",
  unpaid: "billing.statusUnpaid",
  paused: "billing.statusPaused",
  canceling: "billing.statusCanceling",
  canceled: "billing.statusCanceled",
  active: "billing.statusActive",
  trialing: "billing.statusTrialing",
  none: "billing.noSubscription",
};

export function OrgSettingsBillingPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { features } = useAppConfig();
  const { data: billing, isLoading, error } = useBilling();
  const checkoutMutation = useCheckout();
  const portalMutation = usePortal();

  if (!features.billing) return <Navigate to="/org-settings/general" replace />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!billing) {
    return <EmptyState message={t("billing.noAccount")} icon={CreditCard} compact />;
  }

  const dateLocale = i18n.language === "fr" ? "fr-FR" : "en-US";
  const formatBillingDate = (iso: string) =>
    new Date(iso).toLocaleDateString(dateLocale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

  const statusLabel =
    billing.status === "canceling" && billing.periodEnd
      ? t("billing.statusCanceling", { date: formatBillingDate(billing.periodEnd) })
      : billing.status === "active" && billing.periodEnd
        ? t("billing.cycleReset", { date: formatBillingDate(billing.periodEnd) })
        : t(STATUS_I18N[billing.status] ?? "billing.noSubscription");

  const hasSubscription = billing.status !== "none";

  const handleUpgrade = (planId: string) => {
    checkoutMutation.mutate(
      { planId },
      {
        onSuccess: (url) => {
          window.location.href = url;
        },
        onError: (err: Error) => {
          toast.error(t("error.prefix", { ns: "common", message: err.message }));
        },
      },
    );
  };

  const handleManage = () => {
    portalMutation.mutate(undefined, {
      onSuccess: (url) => {
        window.location.href = url;
      },
      onError: (err: Error) => {
        toast.error(t("error.prefix", { ns: "common", message: err.message }));
      },
    });
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
          ) : billing.upgrades.length > 0 ? (
            <Button size="sm" onClick={() => handleUpgrade(billing.upgrades[0]!.id)}>
              {t("billing.upgrade")}
            </Button>
          ) : null}
        </div>

        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t("billing.usage")}</span>
            <span className="font-medium">
              {billing.usagePercent}%
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                (
                {t("billing.creditsCount", {
                  used: billing.creditsUsed,
                  quota: billing.creditQuota,
                })}
                )
              </span>
            </span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div
              className={`h-full rounded-full transition-all ${getUsageBarColor(billing.usagePercent)}`}
              style={{ width: `${Math.min(billing.usagePercent, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {billing.status === "past_due" && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.pastDueWarning")}
          </p>
          <p className="text-muted-foreground mt-1">{t("billing.pastDueDescription")}</p>
        </div>
      )}

      {billing.status === "canceling" && billing.periodEnd && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.cancelingWarning", { date: formatBillingDate(billing.periodEnd) })}
          </p>
        </div>
      )}

      {billing.plans.length > 0 && (
        <div className="border-border bg-card mb-4 rounded-lg border p-5">
          <h3 className="mb-3 text-[0.95rem] font-semibold">{t("billing.upgradePlans")}</h3>
          <PlanGrid
            plans={billing.plans}
            currentPlanId={billing.plan.id}
            upgradeIds={new Set(billing.upgrades.map((u) => u.id))}
            disabled={checkoutMutation.isPending}
            onSelect={handleUpgrade}
          />
        </div>
      )}
    </>
  );
}
