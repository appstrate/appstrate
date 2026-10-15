// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { FieldError } from "@appstrate/ui/components/field";
import { FormItem } from "@/components/app-ui/form-item";
import { AuthLayout } from "../components/auth-layout";
import { AuthLink, AuthMessage } from "../components/auth-message";
import { useAuth } from "../hooks/use-auth";

export function ForgotPasswordPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"form" | "submitting" | "sent">("form");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState("submitting");
    setError(null);
    try {
      await requestPasswordReset(email.trim());
      setState("sent");
    } catch {
      setError(t("forgotPassword.error"));
      setState("form");
    }
  };

  if (state === "sent") {
    return (
      <AuthLayout>
        <AuthMessage
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
          <FormItem id="email" label={t("login.email")}>
            <Input
              type="email"
              placeholder="email@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </FormItem>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={state === "submitting"}>
            {state === "submitting" ? t("loading") : t("forgotPassword.submit")}
          </Button>
        </form>
        <AuthLink to="/login" className="text-center">
          {t("forgotPassword.backToLogin")}
        </AuthLink>
      </div>
    </AuthLayout>
  );
}
