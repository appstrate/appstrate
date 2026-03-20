import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useOrg } from "../hooks/use-org";
import { useTheme } from "../hooks/use-theme";
import { ArrowLeft, ArrowRight } from "lucide-react";

// eslint-disable-next-line react-refresh/only-export-components
export const ONBOARDING_STEPS = [
  { key: "create" },
  { key: "model" },
  { key: "providers" },
  { key: "members" },
  { key: "complete" },
] as const;

export type StepKey = (typeof ONBOARDING_STEPS)[number]["key"];

function getStepIndex(key: StepKey): number {
  return ONBOARDING_STEPS.findIndex((s) => s.key === key);
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
  const currentIndex = getStepIndex(step);
  const totalSteps = ONBOARDING_STEPS.length;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <img
            src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt="Appstrate"
            className="h-[34px] w-auto"
          />
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2 mb-8">
          {ONBOARDING_STEPS.map((s, i) => (
            <div key={s.key} className="flex-1 flex items-center gap-2">
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
        <div className="text-sm text-muted-foreground mb-1">
          {t("onboarding.stepLabel", { current: currentIndex + 1, total: totalSteps })}
        </div>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </div>

        {/* Content */}
        <div className="mb-6 max-h-[40vh] overflow-y-auto">{children}</div>

        {/* Footer navigation */}
        <div className="flex items-center gap-2 pt-4 border-t border-border">
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
