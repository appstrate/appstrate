// SPDX-License-Identifier: Apache-2.0

import { ToneBadge } from "@/components/app-ui/status-variants";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  OnboardingLayout,
  useOnboardingGuard,
  useOnboardingNav,
} from "../../components/onboarding-layout";
import { CopyLinkButton } from "../../components/copy-link-button";
import { useOrgDetail } from "../../hooks/use-org";
import { roleI18nKey } from "../../hooks/use-permissions";
import {
  OrgInvitationForm,
  type OrgInvitationFormHandle,
} from "../../components/org-invitation-form";
import { TextSkeleton } from "../../components/loading-skeletons";

export function OnboardingMembersStep() {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const orgId = useOnboardingGuard();
  const { nextRoute, prevRoute } = useOnboardingNav("members");
  const inviteFormRef = useRef<OrgInvitationFormHandle>(null);

  const { data: orgData } = useOrgDetail();

  const invitations = orgData?.invitations ?? [];

  const [sending, setSending] = useState(false);

  // An email typed but never sent is still an invitation the user meant to make.
  const goNext = async () => {
    setSending(true);
    const sent = (await inviteFormRef.current?.submitPending()) ?? true;
    setSending(false);
    if (sent && nextRoute) navigate(nextRoute);
  };

  if (!orgId)
    return (
      <OnboardingLayout
        step="members"
        title={t("onboarding.membersTitle")}
        subtitle={t("onboarding.membersSubtitle")}
      >
        <TextSkeleton lines={3} className="py-4" />
      </OnboardingLayout>
    );

  return (
    <OnboardingLayout
      step="members"
      title={t("onboarding.membersTitle")}
      subtitle={t("onboarding.membersSubtitle")}
      onNext={() => void goNext()}
      nextPending={sending}
      onBack={prevRoute ? () => navigate(prevRoute) : undefined}
    >
      <div className="flex flex-col gap-4">
        <OrgInvitationForm ref={inviteFormRef} key={orgId} orgId={orgId} />

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
                  <ToneBadge variant="pending">{t(roleI18nKey(inv.role))}</ToneBadge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </OnboardingLayout>
  );
}
