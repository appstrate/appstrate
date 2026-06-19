// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { useOrg } from "../../hooks/use-org";
import { useAppConfig } from "../../hooks/use-app-config";
import { useModels } from "../../hooks/use-models";
import { useBilling } from "../../hooks/use-billing";
import { $api } from "../../api/client";
import { CheckCircle2 } from "lucide-react";

export function OnboardingDoneStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { currentOrg } = useOrg();
  const { features } = useAppConfig();
  const { prevRoute } = useOnboardingNav("complete");

  const { data: models } = useModels();
  const { data: billing } = useBilling({ enabled: features.billing && !!orgId });
  const { data: orgData } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );

  const defaultModel = models?.find((m) => m.is_default);
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
        <div className="border-border bg-card rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={20} className="shrink-0 text-green-500" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryOrg")}</h3>
              <span className="text-muted-foreground text-sm">{currentOrg?.name}</span>
            </div>
          </div>
        </div>

        {features.billing && billing && (
          <div className="border-border bg-card rounded-lg border p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={20} className="shrink-0 text-green-500" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold">{t("onboarding.summaryPlan")}</h3>
                <span className="text-muted-foreground text-sm">{billing.plan.name}</span>
              </div>
            </div>
          </div>
        )}

        <div className="border-border bg-card rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2
              size={20}
              className={
                defaultModel ? "shrink-0 text-green-500" : "text-muted-foreground shrink-0"
              }
            />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryModel")}</h3>
              <span className="text-muted-foreground text-sm">
                {defaultModel ? defaultModel.label : t("onboarding.summaryModelNone")}
              </span>
            </div>
          </div>
        </div>

        <div className="border-border bg-card rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <CheckCircle2
              size={20}
              className={
                invitationCount > 0 ? "shrink-0 text-green-500" : "text-muted-foreground shrink-0"
              }
            />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">{t("onboarding.summaryMembers")}</h3>
              <span className="text-muted-foreground text-sm">
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
