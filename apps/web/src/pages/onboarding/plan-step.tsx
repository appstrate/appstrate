import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { useAppConfig } from "../../hooks/use-app-config";
import {
  useBilling,
  useCheckout,
  PLAN_ICONS,
  PLAN_DESCRIPTION_KEYS,
} from "../../hooks/use-billing";
import { Spinner } from "../../components/spinner";
import { cn } from "@/lib/utils";
import { Check, Sparkles } from "lucide-react";

export function OnboardingPlanStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { features } = useAppConfig();
  const { nextRoute } = useOnboardingNav("plan");

  // Skip this step in OSS mode (no billing)
  useEffect(() => {
    if (!features.billing && nextRoute) {
      navigate(nextRoute, { replace: true });
    }
  }, [features.billing, navigate, nextRoute]);

  const { data: billing, isLoading } = useBilling({ enabled: !!orgId });
  const checkoutMutation = useCheckout();

  const goNext = () => nextRoute && navigate(nextRoute);

  const currentPlanId = billing?.plan.id ?? "free";
  const upgradeIds = new Set(billing?.upgrades.map((u) => u.id));

  const handleSelectPlan = (planId: string) => {
    checkoutMutation.mutate(
      { planId, returnUrl: "/onboarding/plan" },
      {
        onSuccess: (url) => {
          window.location.href = url;
        },
      },
    );
  };

  if (!orgId) return null;

  return (
    <OnboardingLayout
      step="plan"
      title={t("onboarding.planTitle")}
      subtitle={t("onboarding.planSubtitle")}
      onNext={goNext}
    >
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {(billing?.plans ?? []).map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const isUpgrade = upgradeIds.has(plan.id);
            const Icon = PLAN_ICONS[plan.id] ?? Sparkles;
            const descKey = PLAN_DESCRIPTION_KEYS[plan.id];

            return (
              <button
                key={plan.id}
                className={cn(
                  "relative flex h-52 flex-col items-start rounded-xl border p-5 text-left transition-colors",
                  isCurrent
                    ? "border-primary bg-primary/5"
                    : isUpgrade
                      ? "border-border bg-card hover:border-primary/50"
                      : "border-border bg-card opacity-60",
                )}
                onClick={isUpgrade ? () => handleSelectPlan(plan.id) : undefined}
                disabled={!isUpgrade || checkoutMutation.isPending}
              >
                {isCurrent && (
                  <div className="absolute top-3 right-3 rounded-full bg-primary p-0.5">
                    <Check size={12} className="text-primary-foreground" strokeWidth={3} />
                  </div>
                )}

                <div className={cn(
                  "rounded-lg p-2 mb-3",
                  isCurrent ? "bg-primary/10" : "bg-muted",
                )}>
                  <Icon size={18} className={isCurrent ? "text-primary" : "text-muted-foreground"} />
                </div>

                <div className="font-semibold">{plan.name}</div>
                {descKey && (
                  <p className="text-xs text-muted-foreground mt-0.5">{t(descKey)}</p>
                )}

                <div className="mt-auto pt-3 flex flex-col gap-0.5">
                  <span className="text-xl font-bold">
                    {plan.price === 0
                      ? t("onboarding.planFreePrice")
                      : `$${plan.price}`}
                    {plan.price > 0 && (
                      <span className="text-sm font-normal text-muted-foreground">
                        /{t("billing.month")}
                      </span>
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
          })}
        </div>
      )}
    </OnboardingLayout>
  );
}
