// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { FieldError } from "@appstrate/ui/components/field";
import { AuthLayout } from "../components/auth-layout";
import { AuthLink, AuthMessage } from "../components/auth-message";
import { NewPasswordFields, type NewPasswordValues } from "../components/auth-fields";
import { useAppForm } from "../hooks/use-app-form";
import { useAuth } from "../hooks/use-auth";
import { ApiError } from "../api/errors";
import { errorMessage } from "../lib/mutation-error";

export function ResetPasswordPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { resetPassword } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const form = useAppForm<NewPasswordValues>({
    defaultValues: { newPassword: "", confirmPassword: "" },
  });
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revocationFailed, setRevocationFailed] = useState(false);

  if (!token) {
    return (
      <AuthLayout>
        <AuthMessage
          icon={AlertCircle}
          tone="destructive"
          description={t("resetPassword.invalidToken")}
          backTo="/forgot-password"
          backLabel={t("resetPassword.requestNew")}
        />
      </AuthLayout>
    );
  }

  const onSubmit = async ({ newPassword }: NewPasswordValues) => {
    setError(null);
    try {
      await resetPassword(token, newPassword);
      setSuccess(true);
    } catch (err) {
      // The password is written and the link spent: not an invalid link.
      const failed = err instanceof ApiError && err.code === "credential_change_revocation_failed";
      setRevocationFailed(failed);
      setError(failed ? errorMessage(err) : t("resetPassword.invalidToken"));
    }
  };

  if (success) {
    return (
      <AuthLayout>
        <AuthMessage
          icon={CheckCircle}
          title={t("resetPassword.successTitle")}
          description={t("resetPassword.successDescription")}
          backTo="/login"
          backLabel={t("magicLink.backToLogin")}
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
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
          className="mx-auto flex w-full max-w-sm flex-col gap-4"
        >
          <NewPasswordFields form={form} />
          <FieldError>{error}</FieldError>
          {revocationFailed && (
            <AuthLink to="/forgot-password">{t("resetPassword.requestNew")}</AuthLink>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t("loading") : t("resetPassword.submit")}
          </Button>
        </form>
        <AuthLink to="/login" className="text-center">
          {t("magicLink.backToLogin")}
        </AuthLink>
      </div>
    </AuthLayout>
  );
}
