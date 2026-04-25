// SPDX-License-Identifier: Apache-2.0

// Closed-mode landing page (issue #228). Displayed by `OrgGate` when
// `AUTH_DISABLE_ORG_CREATION=true` and the signed-in user has no
// organization membership. Self-hosters get a calm "wait for invitation"
// screen instead of a broken /onboarding/create flow.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuth } from "../../hooks/use-auth";
import { Mail } from "lucide-react";

export function OnboardingWaitingStep() {
  const { t } = useTranslation("settings");
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
          <Mail className="text-muted-foreground h-6 w-6" aria-hidden />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t("onboarding.waitingTitle")}</h1>
          <p className="text-muted-foreground text-sm">{t("onboarding.waitingSubtitle")}</p>
        </div>
        {user?.email && (
          <p className="text-muted-foreground text-xs">
            {t("onboarding.waitingSignedInAs", { email: user.email })}
          </p>
        )}
        <Button variant="outline" onClick={() => void logout()}>
          {t("onboarding.waitingLogout")}
        </Button>
      </div>
    </div>
  );
}
