import { useTranslation } from "react-i18next";
import { Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { PLAN_ICONS, PLAN_DESCRIPTION_KEYS, type BillingPlanDetail } from "../hooks/use-billing";

interface PlanCardProps {
  plan: BillingPlanDetail;
  isCurrent?: boolean;
  isUpgrade?: boolean;
  disabled?: boolean;
  onSelect?: (planId: string) => void;
}

export function PlanCard({
  plan,
  isCurrent = false,
  isUpgrade = false,
  disabled = false,
  onSelect,
}: PlanCardProps) {
  const { t } = useTranslation(["settings"]);
  const Icon = PLAN_ICONS[plan.id] ?? Sparkles;
  const descKey = PLAN_DESCRIPTION_KEYS[plan.id];

  return (
    <button
      className={cn(
        "relative flex h-52 flex-col items-start rounded-xl border p-5 text-left transition-colors",
        isCurrent
          ? "border-primary bg-primary/5"
          : isUpgrade
            ? "border-border bg-card hover:border-primary/50"
            : "border-border bg-card opacity-60",
      )}
      onClick={isUpgrade && onSelect ? () => onSelect(plan.id) : undefined}
      disabled={!isUpgrade || disabled}
    >
      {isCurrent && (
        <div className="absolute top-3 right-3 rounded-full bg-primary p-0.5">
          <Check size={12} className="text-primary-foreground" strokeWidth={3} />
        </div>
      )}

      <div className={cn("rounded-lg p-2 mb-3", isCurrent ? "bg-primary/10" : "bg-muted")}>
        <Icon size={18} className={isCurrent ? "text-primary" : "text-muted-foreground"} />
      </div>

      <div className="font-semibold">{plan.name}</div>
      {descKey && <p className="text-xs text-muted-foreground mt-0.5">{t(descKey)}</p>}

      <div className="mt-auto pt-3 flex flex-col gap-0.5">
        <span className="text-xl font-bold">
          {plan.price === 0 ? t("onboarding.planFreePrice") : `$${plan.price}`}
          {plan.price > 0 && (
            <span className="text-sm font-normal text-muted-foreground">/{t("billing.month")}</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("onboarding.planCredits", {
            count: plan.creditQuota.toLocaleString(),
          })}
        </span>
      </div>
    </button>
  );
}

interface PlanGridProps {
  plans: BillingPlanDetail[];
  currentPlanId?: string;
  upgradeIds?: Set<string>;
  disabled?: boolean;
  onSelect?: (planId: string) => void;
}

export function PlanGrid({
  plans,
  currentPlanId,
  upgradeIds,
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
          isUpgrade={upgradeIds?.has(plan.id) ?? false}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
