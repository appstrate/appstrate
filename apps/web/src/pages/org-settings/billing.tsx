// SPDX-License-Identifier: Apache-2.0

import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CreditCard } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { formatBytes } from "@appstrate/core/format";
import { useAppConfig } from "../../hooks/use-app-config";
import { useBilling, useCheckout, usePortal } from "../../hooks/use-billing";
import { useOrgStorage } from "../../hooks/use-org-storage";
import { getUsageBarColor } from "../../lib/usage-severity";
import { PlanGrid } from "../../components/plan-card";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { formatDateField } from "../../lib/markdown";
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
  const { t } = useTranslation(["settings", "common"]);
  const { features } = useAppConfig();
  // Gate the cloud fetch on the feature flag (mirrors sidebar-billing) so OSS
  // mode never fires the cloud-only `/billing` request (404). The line-below
  // <Navigate> still handles the visible redirect.
  const { data: billing, isLoading, error } = useBilling({ enabled: features.billing });
  const checkoutMutation = useCheckout();
  const portalMutation = usePortal();

  // Storage entitlement — core data (organizations.documents_bytes_*), shown
  // next to the credit gauge because the plan drives the storage limit in
  // cloud mode. Same source (useOrgStorage) as the org-settings/general storage
  // section. Gated on the billing flag to mirror the credit fetch above.
  const {
    storage,
    limitBytes: storageLimit,
    percent: storagePercent,
  } = useOrgStorage({ enabled: features.billing });

  if (!features.billing) return <Navigate to="/org-settings/general" replace />;
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
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

  const handleUpgrade = (planId: string) => {
    checkoutMutation.mutate(
      { planId, returnUrl: "/org-settings/billing" },
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
          <div
            className="bg-muted h-2 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={Math.min(billing.usage_percent, 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("billing.usage")}
          >
            <div
              className={`h-full rounded-full transition-all ${getUsageBarColor(billing.usage_percent)}`}
              style={{ width: `${Math.min(billing.usage_percent, 100)}%` }}
            />
          </div>
        </div>

        {storage && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("billing.storageUsage")}</span>
              <span className="font-medium">
                {storageLimit === null
                  ? t("orgStorage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
                  : `${storagePercent}%`}
                {storageLimit !== null && (
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    (
                    {t("orgStorage.usedOfLimit", {
                      used: formatBytes(storage.used_bytes),
                      limit: formatBytes(storageLimit),
                    })}
                    )
                  </span>
                )}
              </span>
            </div>
            {storageLimit !== null && (
              <div
                className="bg-muted h-2 overflow-hidden rounded-full"
                role="progressbar"
                aria-valuenow={storagePercent ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t("billing.storageUsage")}
              >
                <div
                  className={`h-full rounded-full transition-all ${getUsageBarColor(storagePercent ?? 0)}`}
                  style={{ width: `${storagePercent ?? 0}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {billing.status === "past_due" && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.pastDueWarning")}
          </p>
          <p className="text-muted-foreground mt-1">{t("billing.pastDueDescription")}</p>
        </div>
      )}

      {billing.status === "canceling" && billing.period_end && (
        <div className="mb-4 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 text-sm">
          <p className="font-medium text-yellow-600 dark:text-yellow-400">
            {t("billing.cancelingWarning", { date: formatDateField(billing.period_end, "date") })}
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
