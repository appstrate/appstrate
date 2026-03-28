import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "../components/auth-layout";
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
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-8 w-8 text-primary" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">{t("forgotPassword.sentTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("forgotPassword.sentDescription")}</p>
          </div>
          <Link
            to="/login"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
          >
            {t("forgotPassword.backToLogin")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">{t("forgotPassword.title")}</h1>
          <p className="text-center text-sm text-muted-foreground">
            {t("forgotPassword.description")}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto w-full max-w-sm flex flex-col gap-4">
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("forgotPassword.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
        >
          {t("forgotPassword.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
