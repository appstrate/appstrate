import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { useTheme } from "../stores/theme-store";
import { useAppConfig } from "../hooks/use-app-config";
import { ArrowLeft, ArrowRight } from "lucide-react";

export type StepKey = "create" | "plan" | "model" | "providers" | "members" | "complete";

interface StepDef {
  key: StepKey;
  route: string;
}

const ALL_STEPS: (StepDef & { showWhen?: "models" | "billing" })[] = [
  { key: "create", route: "/onboarding/create" },
  { key: "plan", route: "/onboarding/plan", showWhen: "billing" },
  { key: "model", route: "/onboarding/model", showWhen: "models" },
  { key: "providers", route: "/onboarding/providers" },
  { key: "members", route: "/onboarding/members" },
  { key: "complete", route: "/onboarding/complete" },
];

/**
 * Returns the active onboarding steps filtered by feature flags.
 * OSS: create → model → providers → members → complete
 * Cloud: create → plan → providers → members → complete
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOnboardingSteps(): StepDef[] {
  const { features } = useAppConfig();
  return useMemo(
    () =>
      ALL_STEPS.filter((s) => {
        if (!s.showWhen) return true;
        return features[s.showWhen];
      }),
    [features],
  );
}

/**
 * Navigation helpers for a given step within the active onboarding flow.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOnboardingNav(current: StepKey) {
  const steps = useOnboardingSteps();
  const idx = steps.findIndex((s) => s.key === current);
  return useMemo(
    () => ({
      steps,
      index: idx,
      total: steps.length,
      nextRoute: idx < steps.length - 1 ? steps[idx + 1]!.route : null,
      prevRoute: idx > 0 ? steps[idx - 1]!.route : null,
    }),
    [steps, idx],
  );
}

/**
 * Guard hook: redirects to /onboarding/create if the user has no real org (steps 2-5).
 * Uses the resolved currentOrg from the API, not the raw localStorage orgId,
 * to avoid stale IDs from deleted orgs.
 * Returns the currentOrg id or null.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOnboardingGuard() {
  const { currentOrg, loading, orgs } = useOrg();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait until orgs are fully loaded before deciding to redirect.
    // After switchOrg(), the query cache is cleared and briefly returns
    // orgs=[] with isLoading=false before the refetch starts.
    if (!loading && orgs.length === 0) {
      navigate("/onboarding/create", { replace: true });
    }
  }, [orgs, loading, navigate]);

  return currentOrg?.id ?? null;
}

interface OnboardingLayoutProps {
  step: StepKey;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onNext?: () => void;
  onBack?: () => void;
  nextDisabled?: boolean;
  nextPending?: boolean;
  nextLabel?: string;
}

export function OnboardingLayout({
  step,
  title,
  subtitle,
  children,
  onNext,
  onBack,
  nextDisabled = false,
  nextPending = false,
  nextLabel,
}: OnboardingLayoutProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { resolvedTheme } = useTheme();
  const { steps, index: currentIndex, total: totalSteps } = useOnboardingNav(step);

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <img
            src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt="Appstrate"
            className="h-[34px] w-auto"
          />
        </div>

        {/* Progress bar */}
        <div className="mb-8 flex items-center gap-2">
          {steps.map((s, i) => (
            <div key={s.key} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "h-1.5 w-full rounded-full transition-colors",
                  i <= currentIndex ? "bg-primary" : "bg-muted",
                )}
              />
            </div>
          ))}
        </div>

        {/* Step label */}
        <div className="text-muted-foreground mb-1 text-sm">
          {t("onboarding.stepLabel", { current: currentIndex + 1, total: totalSteps })}
        </div>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p>}
        </div>

        {/* Content */}
        <div className="mb-6 max-h-[40vh] overflow-y-auto">{children}</div>

        {/* Footer navigation */}
        <div className="border-border flex items-center gap-2 border-t pt-4">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft size={16} className="mr-1" />
              {t("btn.back")}
            </Button>
          ) : (
            <div />
          )}
          <div className="ml-auto flex items-center gap-2">
            {onNext && (
              <Button onClick={onNext} disabled={nextDisabled || nextPending}>
                {nextPending ? t("onboarding.saving") : nextLabel || t("onboarding.next")}
                {!nextPending && <ArrowRight size={16} className="ml-1" />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
