import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { Mail, AlertCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "../components/auth-layout";
import { useAuth } from "../hooks/use-auth";

export function VerifyEmailPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, resendVerificationEmail, logout } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Prefer user email from store (authenticated but unverified), fallback to location state (post-signup redirect)
  const email = user?.email ?? (location.state as { email?: string })?.email ?? "";
  const error = searchParams.get("error");
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  const handleResend = async () => {
    if (!email) return;
    setResendState("sending");
    try {
      await resendVerificationEmail(email);
      setResendState("sent");
      setTimeout(() => setResendState("idle"), 3000);
    } catch {
      setResendState("idle");
    }
  };

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-full">
          <Mail className="text-primary h-8 w-8" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t("verifyEmail.title")}</h1>
          {error && (
            <div className="text-destructive flex items-center justify-center gap-2 text-sm">
              <AlertCircle size={16} />
              <span>{t("preferences.verificationLinkExpired")}</span>
            </div>
          )}
          {!error && (
            <p className="text-muted-foreground text-sm">
              <Trans
                ns="settings"
                i18nKey="verifyEmail.description"
                values={{ email }}
                components={{ strong: <strong /> }}
              />
            </p>
          )}
        </div>
        {email && (
          <Button variant="outline" onClick={handleResend} disabled={resendState !== "idle"}>
            {resendState === "sending"
              ? t("verifyEmail.resending")
              : resendState === "sent"
                ? t("verifyEmail.resent")
                : t("verifyEmail.resend")}
          </Button>
        )}
        {user ? (
          <button
            onClick={() => void logout()}
            className="text-muted-foreground hover:text-primary flex items-center gap-1.5 text-sm underline underline-offset-4"
          >
            <LogOut size={14} />
            {t("userMenu.logout", { ns: "common" })}
          </button>
        ) : (
          <Link
            to="/login"
            className="text-muted-foreground hover:text-primary text-sm underline underline-offset-4"
          >
            {t("verifyEmail.backToLogin")}
          </Link>
        )}
      </div>
    </AuthLayout>
  );
}
