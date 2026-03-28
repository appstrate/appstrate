import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AuthLayout } from "../components/auth-layout";
import { authClient } from "../lib/auth-client";

export function ResetPasswordPage() {
  const { t } = useTranslation(["settings", "common"]);
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<"form" | "submitting" | "success">("form");
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <p className="text-sm text-muted-foreground">{t("resetPassword.invalidToken")}</p>
          <Link
            to="/forgot-password"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
          >
            {t("resetPassword.requestNew")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError(t("validation.minLength", { ns: "common", min: 8 }));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("resetPassword.mismatch"));
      return;
    }

    setState("submitting");
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(t("resetPassword.invalidToken"));
        setState("form");
        return;
      }
      setState("success");
    } catch {
      setError(t("resetPassword.invalidToken"));
      setState("form");
    }
  };

  if (state === "success") {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <CheckCircle className="h-8 w-8 text-primary" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">{t("resetPassword.successTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("resetPassword.successDescription")}</p>
          </div>
          <Link
            to="/login"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
          >
            {t("resetPassword.backToLogin")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">{t("resetPassword.title")}</h1>
          <p className="text-center text-sm text-muted-foreground">
            {t("resetPassword.description")}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto w-full max-w-sm flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="password">{t("resetPassword.newPassword")}</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">{t("resetPassword.confirmPassword")}</Label>
            <Input
              id="confirm-password"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={cn(
                confirmPassword && password !== confirmPassword && "border-destructive",
              )}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("resetPassword.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
        >
          {t("resetPassword.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
