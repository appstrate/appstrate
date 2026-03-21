import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { OnboardingLayout, useOnboardingGuard, useOnboardingNav } from "../../components/onboarding-layout";
import { useOrg } from "../../hooks/use-org";
import { useAppConfig } from "../../hooks/use-app-config";
import { useModels } from "../../hooks/use-models";
import { useBilling } from "../../hooks/use-billing";
import { useProviders } from "../../hooks/use-providers";
import { api } from "../../api";
import { CheckCircle2 } from "lucide-react";
import type { OrgInvitation } from "@appstrate/shared-types";

export function OnboardingDoneStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { currentOrg } = useOrg();
  const { features } = useAppConfig();
  const { prevRoute } = useOnboardingNav("complete");

  const { data: models } = useModels();
  const { data: billing } = useBilling({ enabled: features.billing });
  const { data: providersData } = useProviders();
  const { data: orgData } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: () => api<{ invitations: OrgInvitation[] }>(`/orgs/${orgId}`),
    enabled: !!orgId,
  });

  const defaultModel = models?.find((m) => m.isDefault);
  const configuredProviders = (providersData?.providers ?? []).filter((p) => p.enabled);
  const invitationCount = orgData?.invitations?.length ?? 0;

  if (!orgId) return null;

  return (
    <OnboardingLayout
      step="complete"
      title={t("onboarding.doneTitle")}
      subtitle={t("onboarding.doneSubtitle")}
      onBack={prevRoute ? () => navigate(prevRoute) : undefined}
      onNext={() => navigate("/")}
      nextLabel={t("onboarding.goToDashboard")}
    >
      <div className="flex flex-col gap-4">
        {/* Summary cards */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={20} className="text-green-500 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryOrg")}</h3>
              <span className="text-sm text-muted-foreground">{currentOrg?.name}</span>
            </div>
          </div>
        </div>

        {features.billing && billing && (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={20} className="text-green-500 shrink-0" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("onboarding.summaryPlan")}</h3>
                <span className="text-sm text-muted-foreground">{billing.plan.name}</span>
              </div>
            </div>
          </div>
        )}

        {features.models && (
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2
                size={20}
                className={
                  defaultModel ? "text-green-500 shrink-0" : "text-muted-foreground shrink-0"
                }
              />
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("onboarding.summaryModel")}</h3>
                <span className="text-sm text-muted-foreground">
                  {defaultModel ? defaultModel.label : t("onboarding.summaryModelNone")}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2
              size={20}
              className={
                configuredProviders.length > 0
                  ? "text-green-500 shrink-0"
                  : "text-muted-foreground shrink-0"
              }
            />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryProviders")}</h3>
              <span className="text-sm text-muted-foreground">
                {configuredProviders.length > 0
                  ? t("onboarding.summaryProvidersCount", { count: configuredProviders.length })
                  : t("onboarding.summaryProvidersNone")}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2
              size={20}
              className={
                invitationCount > 0 ? "text-green-500 shrink-0" : "text-muted-foreground shrink-0"
              }
            />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryMembers")}</h3>
              <span className="text-sm text-muted-foreground">
                {invitationCount > 0
                  ? t("onboarding.summaryMembersCount", { count: invitationCount })
                  : t("onboarding.summaryMembersNone")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  );
}
