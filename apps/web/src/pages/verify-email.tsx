import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "../components/auth-layout";
import { useAuth } from "../hooks/use-auth";

export function VerifyEmailPage() {
  const { t } = useTranslation("settings");
  const { resendVerificationEmail } = useAuth();
  const location = useLocation();
  const email = (location.state as { email?: string })?.email ?? "";
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
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-8 w-8 text-primary" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t("verifyEmail.title")}</h1>
          <p className="text-sm text-muted-foreground">
            <Trans
              ns="settings"
              i18nKey="verifyEmail.description"
              values={{ email }}
              components={{ strong: <strong /> }}
            />
          </p>
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
        <Link
          to="/login"
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
        >
          {t("verifyEmail.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
