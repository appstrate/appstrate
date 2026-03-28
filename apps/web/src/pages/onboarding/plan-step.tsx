import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { useAppConfig } from "../../hooks/use-app-config";
import { useBilling, useCheckout } from "../../hooks/use-billing";
import { Spinner } from "../../components/spinner";
import { PlanGrid } from "../../components/plan-card";

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
        <PlanGrid
          plans={billing?.plans ?? []}
          currentPlanId={currentPlanId}
          upgradeIds={upgradeIds}
          disabled={checkoutMutation.isPending}
          onSelect={handleSelectPlan}
        />
      )}
    </OnboardingLayout>
  );
}
