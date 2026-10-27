// SPDX-License-Identifier: Apache-2.0

import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { AuthLayout } from "../components/auth-layout";
import { AuthMessage } from "../components/auth-message";

/** Where a magic-link email lands without the OIDC module: inert until the button is pressed. */
export function MagicLinkConfirmPage() {
  const { t } = useTranslation(["settings"]);
  const { search } = useLocation();

  if (!new URLSearchParams(search).get("token")) return <Navigate to="/magic-link" replace />;

  return (
    <AuthLayout>
      <AuthMessage
        icon={Mail}
        title={t("magicLink.confirmTitle")}
        description={t("magicLink.confirmDescription")}
      >
        <Button
          className="w-full max-w-sm"
          onClick={() => window.location.assign(`/api/auth/magic-link/verify${search}`)}
        >
          {t("magicLink.confirmButton")}
        </Button>
      </AuthMessage>
    </AuthLayout>
  );
}
