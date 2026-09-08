// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { CopyLinkButton } from "../../components/copy-link-button";
import { $api } from "../../api/client";
import { roleI18nKey } from "../../hooks/use-permissions";
import { OrgInvitationForm } from "../../components/org-invitation-form";

export function OnboardingMembersStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { nextRoute, prevRoute } = useOnboardingNav("members");

  const { data: orgData } = $api.useQuery(
    "get",
    "/api/orgs/{orgId}",
    { params: { path: { orgId: orgId ?? "" } } },
    { enabled: !!orgId },
  );

  const invitations = orgData?.invitations ?? [];

  const goNext = () => nextRoute && navigate(nextRoute);

  if (!orgId) return null;

  return (
    <OnboardingLayout
      step="members"
      title={t("onboarding.membersTitle")}
      subtitle={t("onboarding.membersSubtitle")}
      onNext={goNext}
      onBack={prevRoute ? () => navigate(prevRoute) : undefined}
    >
      <div className="flex flex-col gap-4">
        <OrgInvitationForm key={orgId} orgId={orgId} />

        {/* Pending invitations — scrollable */}
        {invitations.length > 0 && (
          <div className="flex max-h-[30vh] flex-col gap-2 overflow-y-auto">
            <div className="text-muted-foreground text-sm font-medium">
              {t("onboarding.pendingInvitations")}
            </div>
            {invitations.map((inv) => (
              <div key={inv.id} className="border-border bg-card rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{inv.email}</span>
                  </div>
                  <CopyLinkButton token={inv.token} />
                  <Badge variant="pending">{t(roleI18nKey(inv.role))}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </OnboardingLayout>
  );
}
