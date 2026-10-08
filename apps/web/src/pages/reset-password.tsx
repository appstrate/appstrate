// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { cn } from "@appstrate/ui/cn";
import { AuthLayout } from "../components/auth-layout";
import { AuthSuccessState } from "../components/auth-success-state";
import { MIN_PASSWORD_LENGTH } from "@appstrate/shared-types";
import { useAuth } from "../hooks/use-auth";
import { ResetLinkUnusable } from "../components/reset-link-unusable";
import { resetFailure } from "../lib/reset-failure";

type ResetState = "form" | "submitting" | "success" | "revocation_failed";

export function ResetPasswordPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { resetPassword } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<ResetState>("form");
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <AuthLayout>
        <ResetLinkUnusable message={t("resetPassword.invalidToken")} />
      </AuthLayout>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("validation.minLength", { ns: "common", min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("resetPassword.mismatch"));
      return;
    }

    setState("submitting");
    try {
      await resetPassword(token, password);
      setState("success");
    } catch (err) {
      if (resetFailure(err) === "revocation_failed") {
        setState("revocation_failed");
        return;
      }
      setError(t("resetPassword.invalidToken"));
      setState("form");
    }
  };

  if (state === "revocation_failed") {
    return (
      <AuthLayout>
        <ResetLinkUnusable message={t("resetPassword.revocationFailed")} />
      </AuthLayout>
    );
  }

  if (state === "success") {
    return (
      <AuthLayout>
        <AuthSuccessState
          icon={CheckCircle}
          title={t("resetPassword.successTitle")}
          description={t("resetPassword.successDescription")}
          backTo="/login"
          backLabel={t("resetPassword.backToLogin")}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-xl font-bold">{t("resetPassword.title")}</h1>
          <p className="text-muted-foreground text-center text-sm">
            {t("resetPassword.description")}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-sm flex-col gap-4">
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
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("resetPassword.submit")}
          </Button>
        </form>
        <Link
          to="/login"
          className="text-muted-foreground hover:text-primary text-center text-sm underline underline-offset-4"
        >
          {t("resetPassword.backToLogin")}
        </Link>
      </div>
    </AuthLayout>
  );
}
