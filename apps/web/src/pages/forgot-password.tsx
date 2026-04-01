import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "../components/auth-layout";
import { AuthSuccessState } from "../components/auth-success-state";
import { authClient } from "../lib/auth-client";

export function ForgotPasswordPage() {
  const { t } = useTranslation(["settings", "common"]);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"form" | "submitting" | "sent">("form");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState("submitting");
    setError(null);
    try {
      await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: "/reset-password",
      });
      setState("sent");
    } catch {
      setError(t("forgotPassword.error"));
      setState("form");
    }
  };

  if (state === "sent") {
    return (
      <AuthLayout>
        <AuthSuccessState
          icon={Mail}
          title={t("forgotPassword.sentTitle")}
          description={t("forgotPassword.sentDescription")}
          backTo="/login"
          backLabel={t("forgotPassword.backToLogin")}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">{t("forgotPassword.title")}</h1>
          <p className="text-muted-foreground text-center text-sm">
            {t("forgotPassword.description")}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-sm flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">{t("login.email")}</Label>
            <Input
              id="email"
              type="email"
              placeholder="email@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("forgotPassword.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-muted-foreground hover:text-primary text-center text-sm underline underline-offset-4"
        >
          {t("forgotPassword.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
