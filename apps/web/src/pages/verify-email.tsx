// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { Mail, AlertCircle, LogOut } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { AuthLayout } from "../components/auth-layout";
import { AuthLink, AuthMessage } from "../components/auth-message";
import { useAuth } from "../hooks/use-auth";

export function VerifyEmailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, resendVerificationEmail, logout } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Prefer user email from store (authenticated but unverified), fallback to
  // location state (post-signup redirect from SPA flow) or the `?email=`
  // query param (server-rendered OIDC register flow in SMTP mode).
  const state = location.state as { email?: string; callbackURL?: string } | null;
  const email = user?.email ?? state?.email ?? searchParams.get("email") ?? "";
  const error = searchParams.get("error");
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const handleResend = async () => {
    if (!email) return;
    setResendState("sending");
    try {
      // Keep the destination the first link carried (e.g. an invitation).
      await resendVerificationEmail(email, state?.callbackURL);
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 3000);
    } catch {
      setResendState("idle");
    }
  };

  // Opened on its own: there is no address to talk about and nothing to resend.
  if (!email && !error) return <Navigate to="/login" replace />;

  return (
    <AuthLayout>
      <AuthMessage
        icon={Mail}
        title={t("verifyEmail.title")}
        description={
          error ? (
            <span className="text-destructive flex items-center justify-center gap-2">
              <AlertCircle size={16} />
              <span>{t("preferences.verificationLinkExpired")}</span>
            </span>
          ) : (
            <Trans
              ns="settings"
              i18nKey="verifyEmail.description"
              values={{ email }}
              components={{ strong: <strong /> }}
            />
          )
        }
        backTo={user ? undefined : "/login"}
        backLabel={t("verifyEmail.backToLogin")}
      >
        {email && (
          <Button variant="outline" onClick={handleResend} disabled={resendState !== "idle"}>
            {resendState === "sending"
              ? t("verifyEmail.resending")
              : resendState === "sent"
                ? t("verifyEmail.resent")
                : t("verifyEmail.resend")}
          </Button>
        )}
        {user && (
          <AuthLink onClick={() => void logout()} className="flex items-center gap-1.5">
            <LogOut size={14} />
            {t("userMenu.logout", { ns: "common" })}
          </AuthLink>
        )}
      </AuthMessage>
    </AuthLayout>
  );
}
