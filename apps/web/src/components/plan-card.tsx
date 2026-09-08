// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { formatBytes } from "@appstrate/core/format";
import {
  PLAN_ICONS,
  PLAN_DESCRIPTION_KEYS,
  type BillingPlanDetail,
  type CheckoutPlanId,
} from "../hooks/use-billing";

interface PlanCardProps {
  plan: BillingPlanDetail;
  isCurrent?: boolean;
  /** The id to check out with, present exactly when this plan is an upgrade. */
  upgradeTarget?: CheckoutPlanId;
  disabled?: boolean;
  onSelect?: (planId: CheckoutPlanId) => void;
}

function PlanCard({
  plan,
  isCurrent = false,
  upgradeTarget,
  disabled = false,
  onSelect,
}: PlanCardProps) {
  const { t } = useTranslation(["settings"]);
  const Icon = PLAN_ICONS[plan.id];
  const descKey = PLAN_DESCRIPTION_KEYS[plan.id];
  const isUpgrade = upgradeTarget !== undefined;

  return (
    <button
      className={cn(
        // h-56, not h-52: the fixed height has to hold price + credits +
        // storage without the entitlement lines wrapping into the description.
        "relative flex h-56 flex-col items-start rounded-xl border p-5 text-left transition-colors",
        isCurrent
          ? "border-primary bg-primary/5"
          : isUpgrade
            ? "border-border bg-card hover:border-primary/50"
            : "border-border bg-card opacity-60",
      )}
      onClick={upgradeTarget && onSelect ? () => onSelect(upgradeTarget) : undefined}
      disabled={!isUpgrade || disabled}
    >
      {isCurrent && (
        <div className="bg-primary absolute top-3 right-3 rounded-full p-0.5">
          <Check size={12} className="text-primary-foreground" strokeWidth={3} />
        </div>
      )}

      <div className={cn("mb-3 rounded-lg p-2", isCurrent ? "bg-primary/10" : "bg-muted")}>
        <Icon size={18} className={isCurrent ? "text-primary" : "text-muted-foreground"} />
      </div>

      <div className="font-semibold">{plan.name}</div>
      <p className="text-muted-foreground mt-0.5 text-xs">{t(descKey)}</p>

      <div className="mt-auto flex flex-col gap-0.5 pt-3">
        <span className="text-xl font-bold">
          {plan.price === 0 ? t("onboarding.planFreePrice") : `$${plan.price}`}
          {plan.price > 0 && (
            <span className="text-muted-foreground text-sm font-normal">/{t("billing.month")}</span>
          )}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("onboarding.planCredits", {
            count: plan.credit_quota.toLocaleString(),
          })}
        </span>
        {/* Storage entitlement — the plan's other metered resource. */}
        <span className="text-muted-foreground text-xs">
          {t("onboarding.planStorage", { size: formatBytes(plan.file_storage_bytes) })}
        </span>
      </div>
    </button>
  );
}

interface PlanGridProps {
  plans: BillingPlanDetail[];
  currentPlanId?: string;
  /** The ids the org may check out with, from `GET /api/billing`'s `upgrades`. */
  upgrades?: readonly CheckoutPlanId[];
  disabled?: boolean;
  onSelect?: (planId: CheckoutPlanId) => void;
}

export function PlanGrid({
  plans,
  currentPlanId,
  upgrades,
  disabled = false,
  onSelect,
}: PlanGridProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          isCurrent={plan.id === currentPlanId}
          upgradeTarget={upgrades?.find((id) => id === plan.id)}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
