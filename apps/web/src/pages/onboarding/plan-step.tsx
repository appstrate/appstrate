import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { OnboardingLayout, useOnboardingGuard, useOnboardingNav } from "../../components/onboarding-layout";
import { useAppConfig } from "../../hooks/use-app-config";
import { useBilling, useCheckout } from "../../hooks/use-billing";
import { Spinner } from "../../components/spinner";
import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";

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

  const { data: billing, isLoading } = useBilling();
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
        <div className="flex flex-col gap-3">
          {(billing?.plans ?? []).map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const isUpgrade = upgradeIds.has(plan.id);

            return (
              <button
                key={plan.id}
                className={cn(
                  "rounded-lg border p-4 text-left transition-colors",
                  isCurrent
                    ? "border-primary bg-primary/5"
                    : isUpgrade
                      ? "border-border bg-card hover:border-primary/50"
                      : "border-border bg-card opacity-60",
                )}
                onClick={isUpgrade ? () => handleSelectPlan(plan.id) : undefined}
                disabled={!isUpgrade || checkoutMutation.isPending}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold">{plan.name}</div>
                    {plan.price === 0 && (
                      <div className="text-sm text-muted-foreground mt-0.5">
                        {t("onboarding.planFreeDescription")}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {plan.price === 0
                        ? t("onboarding.planFreePrice")
                        : `$${plan.price}/${t("billing.month")}`}
                    </span>
                    {isCurrent && <CheckCircle2 size={18} className="text-primary shrink-0" />}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </OnboardingLayout>
  );
}
