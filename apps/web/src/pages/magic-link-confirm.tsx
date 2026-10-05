// SPDX-License-Identifier: Apache-2.0

import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { AuthLayout } from "../components/auth-layout";

/**
 * Where a magic-link email lands on an instance without the OIDC module (with
 * it, the module's own hosted interstitial plays this role).
 *
 * Better Auth's verify endpoint spends the one-time token on its first GET,
 * and mail scanners open the links they find. They get this page, which does
 * nothing until its reader presses the button.
 */
export function MagicLinkConfirmPage() {
  const { t } = useTranslation(["settings"]);
  const { search } = useLocation();

  if (!new URLSearchParams(search).get("token")) return <Navigate to="/magic-link" replace />;

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-full">
          <Mail className="text-primary h-8 w-8" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t("magicLink.confirmTitle")}</h1>
          <p className="text-muted-foreground text-sm">{t("magicLink.confirmDescription")}</p>
        </div>
        <Button
          className="w-full max-w-sm"
          onClick={() => window.location.assign(`/api/auth/magic-link/verify${search}`)}
        >
          {t("magicLink.confirmButton")}
        </Button>
      </div>
    </AuthLayout>
  );
}
